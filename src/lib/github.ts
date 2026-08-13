import "server-only";

import {
  GitHubPoolError,
  getGitHubPoolConfig,
  listGitHubTokens,
  selectGitHubToken,
  markTokenInvalid,
  markTokenExhausted,
  markTokenCooldown,
  markTokenUse,
  updateTokenFromHeaders,
  parseRateLimitHeaders,
  getEarliestRetryAt,
  type GitHubRequestCategory,
  type RateLimitHeaders,
} from "./github-token-pool";
import { acquireGitHubPermit } from "./github-semaphore";

export { GitHubPoolError, getGitHubPoolConfig };

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const DEFAULT_TIMEOUT_MS = 15_000;
const VALIDATION_TIMEOUT_MS = 10_000;

interface GitHubRepo {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string; avatar_url: string };
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  watchers_count: number;
  language: string | null;
  topics: string[];
  license: { name: string } | null;
  created_at: string;
  pushed_at: string;
  updated_at: string;
  homepage: string | null;
  html_url: string;
  default_branch: string;
  private: boolean;
}

interface GitHubSearchResponse {
  total_count: number;
  items: GitHubRepo[];
}

export interface GitHubContentItem {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: "file" | "dir" | "symlink" | "submodule";
  download_url: string | null;
  html_url: string;
  url: string;
}

export interface GitHubFileContent extends GitHubContentItem {
  content: string;
  encoding: string;
  decodedContent: string;
}

// ---------- 缓存：单飞 + path 维度（带上限与自动过期清理） ----------

const MAX_CACHE_ENTRIES = 500;
const cache = new Map<string, { data: unknown; expires: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;
const inflight = new Map<string, Promise<unknown>>();

export function clearGitHubCache(): void {
  cache.clear();
  inflight.clear();
}

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCached(key: string, data: unknown): void {
  const now = Date.now();
  if (cache.size >= MAX_CACHE_ENTRIES) {
    for (const [k, v] of cache.entries()) {
      if (now > v.expires) cache.delete(k);
    }
  }
  while (cache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
  cache.set(key, { data, expires: now + CACHE_TTL_MS });
}

// ---------- 分类与配置 ----------

function classifyPath(path: string): GitHubRequestCategory {
  return path.startsWith("/search/") ? "search" : "core";
}

function getEnvToken(): string | null {
  const t = process.env.GITHUB_TOKEN;
  if (!t) return null;
  if (t.includes("your_")) return null;
  return t.trim() || null;
}

function ensureIsPublic(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return "is:public";
  if (/\bis:public\b/.test(trimmed)) return trimmed;
  if (/\bis:private\b/.test(trimmed)) {
    return trimmed.replace(/\bis:private\b/g, "is:public");
  }
  return `${trimmed} is:public`;
}

// ---------- 错误类型 ----------

class GitHubError extends Error {
  readonly status: number;
  readonly requestId?: string;
  readonly body?: string;
  constructor(status: number, statusText: string, body?: string, requestId?: string) {
    super(`GitHub API error: ${status} ${statusText}`.replace(/\s+$/, ""));
    this.name = "GitHubError";
    this.status = status;
    if (body) this.body = body;
    if (requestId) this.requestId = requestId;
  }
}

// ---------- 底层 fetch ----------

function buildHeaders(token: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "AI-GitHub-Search/1.0",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function rawFetch(
  path: string,
  tokenValue: string | null,
  opts: { signal?: AbortSignal }
): Promise<Response> {
  const timeoutMs = Number(process.env.GITHUB_REQUEST_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await fetch(`${GITHUB_API_BASE}${path}`, {
      headers: buildHeaders(tokenValue),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

async function parseJson<T>(res: Response): Promise<T> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    text = "";
  }
  if (!text) {
    try {
      return (await res.json()) as T;
    } catch {
      return null as unknown as T;
    }
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return null as unknown as T;
  }
}

// ---------- 403 分类 ----------

type ForbiddenDecision =
  | { type: "secondary"; retryAt: Date }
  | { type: "exhausted"; resetAt: Date | null }
  | { type: "permission" };

async function classify403(
  res: Response,
  headers: RateLimitHeaders
): Promise<ForbiddenDecision> {
  const body = await safeText(res);
  const lower = body.toLowerCase();

  if (headers.retryAfterSeconds !== null && headers.retryAfterSeconds !== undefined) {
    const retryAt = new Date(Date.now() + headers.retryAfterSeconds * 1000);
    return { type: "secondary", retryAt };
  }
  if (lower.includes("secondary rate limit")) {
    return { type: "secondary", retryAt: new Date(Date.now() + 60_000) };
  }

  const remaining = headers.remaining;
  const resetAt = headers.resetAt;
  if (remaining === 0) {
    return { type: "exhausted", resetAt };
  }
  if (lower.includes("rate limit") || lower.includes("api rate limit")) {
    return { type: "exhausted", resetAt };
  }
  return { type: "permission" };
}

// ---------- 候选句柄 ----------

interface Candidate {
  kind: "pool" | "env" | "anon";
  id: string;
  tokenValue: string | null;
  releaseClaim?: () => void;
}

// ---------- 调度核心 ----------

interface DispatchOptions {
  category?: GitHubRequestCategory;
  signal?: AbortSignal;
}

async function rotateAndFetch<T>(
  path: string,
  category: GitHubRequestCategory,
  opts: DispatchOptions
): Promise<T> {
  const configured = await listGitHubTokens();
  const hasConfigured = configured.length > 0;
  const envToken = getEnvToken();
  const exclude = new Set<string>();
  let triedEnv = false;
  let triedAnon = false;
  let retryableAttempted = false;
  let attempts = 0;

  while (true) {
    attempts++;
    if (attempts > 64) {
      const earliest = getEarliestRetryAt(category);
      throw new GitHubPoolError("ALL_EXHAUSTED", "Too many GitHub token rotations", {
        status: 429,
        retryAt: earliest,
      });
    }

    let candidate: Candidate | null = null;
    if (hasConfigured) {
      const handle = await selectGitHubToken(category, { exclude });
      if (handle) {
        candidate = {
          kind: "pool",
          id: handle.id,
          tokenValue: handle.tokenValue,
          releaseClaim: handle.releaseClaim,
        };
        exclude.add(handle.id);
      }
    } else {
      // 池为空：env 兜底，再匿名
      if (envToken && !triedEnv) {
        candidate = { kind: "env", id: "env", tokenValue: envToken };
        triedEnv = true;
      } else if (!triedAnon) {
        candidate = { kind: "anon", id: "anon", tokenValue: null };
        triedAnon = true;
      }
    }

    if (!candidate) {
      if (hasConfigured) {
        const earliest = getEarliestRetryAt(category);
        throw new GitHubPoolError("ALL_EXHAUSTED", "All GitHub tokens exhausted or unavailable", {
          status: 429,
          retryAt: earliest,
        });
      }
      throw new GitHubPoolError("POOL_EMPTY", "No GitHub token configured", { status: 500 });
    }

    const { kind, id, tokenValue, releaseClaim } = candidate;

    try {
      let res: Response;
      try {
        res = await rawFetch(path, tokenValue, opts);
      } catch (err) {
        if (!retryableAttempted) {
          retryableAttempted = true;
          if (kind === "pool") markTokenUse(id, path);
          continue;
        }
        throw new GitHubPoolError(
          "UPSTREAM_ERROR",
          `GitHub network error: ${err instanceof Error ? err.message : String(err)}`,
          { status: 503 }
        );
      }

      const headersObj = res.headers ?? new Headers();
      const rlHeaders = parseRateLimitHeaders(headersObj);
      const requestId = rlHeaders.requestId ?? undefined;
      if (kind === "pool") {
        await updateTokenFromHeaders(id, category, rlHeaders);
        markTokenUse(id, path);
      }

      const status = res.status;

      if (res.ok) {
        const data = await parseJson<T>(res);
        return data;
      }

      if (status === 401) {
        if (kind === "pool") {
          markTokenInvalid(id, "401 invalid credentials");
          continue; // 切换下一个 token
        }
        throw new GitHubPoolError("INVALID", "GitHub token invalid", { status: 401 });
      }

      if (status === 403) {
        const decision = await classify403(res, rlHeaders);
        if (decision.type === "secondary") {
          if (kind === "pool") markTokenCooldown(id, category, decision.retryAt);
          // secondary：停止轮换，抛出 429
          throw new GitHubPoolError("SECONDARY", "GitHub secondary rate limit", {
            status: 429,
            retryAt: decision.retryAt,
          });
        }
        if (decision.type === "exhausted") {
          if (kind === "pool") {
            markTokenExhausted(id, category, decision.resetAt);
            continue;
          }
          throw new GitHubPoolError("ALL_EXHAUSTED", "GitHub rate limit exhausted", {
            status: 429,
            retryAt: decision.resetAt ?? undefined,
          });
        }
        // 普通权限 403：不轮换
        const body = await safeText(res);
        throw new GitHubError(403, res.statusText, body, requestId);
      }

      if (status === 404 || status === 422) {
        const body = await safeText(res);
        throw new GitHubError(status, res.statusText, body, requestId);
      }

      if (status >= 500) {
        if (!retryableAttempted && kind === "pool") {
          retryableAttempted = true;
          continue; // 5xx 最多换一次 token
        }
        const body = await safeText(res);
        throw new GitHubError(status, res.statusText, body, requestId);
      }

      // 其余 4xx：不轮换
      const body = await safeText(res);
      throw new GitHubError(status, res.statusText, body, requestId);
    } finally {
      // 每次候选结束，必定释放在途 Claim
      if (releaseClaim) releaseClaim();
    }
  }
}

async function dispatch<T>(path: string, opts: DispatchOptions = {}): Promise<T> {
  const category = opts.category ?? classifyPath(path);

  // 缓存命中
  const cached = getCached<T>(path);
  if (cached) return cached;

  // 单飞
  const existing = inflight.get(path);
  if (existing) return existing as Promise<T>;

  const run = (async (): Promise<T> => {
    let permit;
    try {
      permit = await acquireGitHubPermit();
    } catch (err) {
      if (err instanceof GitHubPoolError) throw err;
      throw new GitHubPoolError("TIMEOUT", "Upstream concurrency unavailable", { status: 503 });
    }
    try {
      return await rotateAndFetch<T>(path, category, opts);
    } finally {
      permit.release();
    }
  })();

  inflight.set(path, run);
  try {
    const data = await run;
    setCached(path, data);
    return data;
  } finally {
    inflight.delete(path);
  }
}

// ---------- 路径编码 ----------

function encodeGitHubPath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

// ---------- 强制公开资源断言 ----------

async function assertPublicRepo(owner: string, repo: string): Promise<GitHubRepo> {
  const repoData = await getRepo(owner, repo);
  if (repoData.private) {
    throw new GitHubError(404, "Not Found", "Repository is private or not found");
  }
  return repoData;
}

// ---------- 公共 API ----------

export async function searchRepos(
  query: string,
  options: {
    sort?: "stars" | "forks" | "updated";
    order?: "desc" | "asc";
    page?: number;
    perPage?: number;
  } = {},
  _token?: string
): Promise<GitHubSearchResponse> {
  const finalQuery = ensureIsPublic(query);
  const params = new URLSearchParams({
    q: finalQuery,
    page: String(options.page ?? 1),
    per_page: String(options.perPage ?? 20),
  });
  if (options.sort) {
    params.set("sort", options.sort);
    params.set("order", options.order ?? "desc");
  }
  return dispatch<GitHubSearchResponse>(`/search/repositories?${params}`, {
    category: "search",
  });
}

export async function getRepo(
  owner: string,
  repo: string,
  _token?: string
): Promise<GitHubRepo> {
  const repoData = await dispatch<GitHubRepo>(`/repos/${owner}/${repo}`, { category: "core" });
  if (repoData && repoData.private === true) {
    throw new GitHubError(404, "Not Found", "Repository is private or not found");
  }
  return repoData;
}

export async function getRepoReadme(
  owner: string,
  repo: string,
  _token?: string
): Promise<string> {
  await assertPublicRepo(owner, repo);
  const raw = await dispatch<{ content: string; encoding: string }>(
    `/repos/${owner}/${repo}/readme`,
    { category: "core" }
  );
  if (raw.encoding === "base64") {
    return Buffer.from(raw.content, "base64").toString("utf-8");
  }
  return raw.content ?? "";
}

export async function getRepoContents(
  owner: string,
  repo: string,
  path = "",
  _token?: string
): Promise<GitHubContentItem[]> {
  await assertPublicRepo(owner, repo);
  const encodedPath = encodeGitHubPath(path);
  const endpoint = encodedPath
    ? `/repos/${owner}/${repo}/contents/${encodedPath}`
    : `/repos/${owner}/${repo}/contents`;
  const data = await dispatch<GitHubContentItem | GitHubContentItem[]>(endpoint, {
    category: "core",
  });
  const items = Array.isArray(data) ? data : [data];
  return [...items].sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export async function getRepoFileContent(
  owner: string,
  repo: string,
  path: string,
  _token?: string
): Promise<GitHubFileContent> {
  const encodedPath = encodeGitHubPath(path);
  if (!encodedPath) {
    throw new Error("File path is required");
  }
  await assertPublicRepo(owner, repo);
  const data = await dispatch<GitHubContentItem & { content?: string; encoding?: string }>(
    `/repos/${owner}/${repo}/contents/${encodedPath}`,
    { category: "core" }
  );
  if (data.type !== "file") {
    throw new Error("Requested path is not a file");
  }
  if (typeof data.content !== "string") {
    throw new Error("File content is not available from GitHub API");
  }
  const decodedContent =
    data.encoding === "base64"
      ? Buffer.from(data.content.replace(/\s/g, ""), "base64").toString("utf-8")
      : data.content;
  return {
    ...data,
    content: data.content,
    encoding: data.encoding ?? "utf-8",
    decodedContent,
  };
}

export async function getRepoLanguages(
  owner: string,
  repo: string,
  _token?: string
): Promise<Record<string, number>> {
  await assertPublicRepo(owner, repo);
  return dispatch<Record<string, number>>(`/repos/${owner}/${repo}/languages`, {
    category: "core",
  });
}

export async function getTrendingRepos(
  period: "daily" | "weekly" | "monthly" = "daily",
  language?: string,
  _token?: string
): Promise<GitHubRepo[]> {
  const date = new Date();
  switch (period) {
    case "daily":
      date.setDate(date.getDate() - 1);
      break;
    case "weekly":
      date.setDate(date.getDate() - 7);
      break;
    case "monthly":
      date.setMonth(date.getMonth() - 1);
      break;
  }
  const dateStr = date.toISOString().split("T")[0];
  let query = `created:>${dateStr}`;
  if (language) {
    query += ` language:${language}`;
  }
  const result = await searchRepos(query, { sort: "stars", order: "desc", perPage: 30 });
  return result.items;
}

// ---------- 验证 / 身份 / 额度 helper（带超时） ----------

export interface GitHubTokenIdentity {
  id: string | null;
  login: string | null;
  name: string | null;
  avatarUrl: string | null;
  scopes: string[];
}

export interface GitHubQuotaSummary {
  core: { limit: number; remaining: number; resetAt: Date | null };
  search: { limit: number; remaining: number; resetAt: Date | null };
}

export interface GitHubTokenValidationResult {
  valid: boolean;
  identity: GitHubTokenIdentity | null;
  quota: GitHubQuotaSummary | null;
  error?: string;
  status?: number;
}

async function rawCallWithToken<T>(path: string, token: string): Promise<{ res: Response; data: T | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);
  try {
    const res = await fetch(`${GITHUB_API_BASE}${path}`, {
      headers: buildHeaders(token),
      signal: controller.signal,
    });
    let data: T | null = null;
    try {
      if (res.ok) data = (await res.json()) as T;
    } catch {
      data = null;
    }
    return { res, data };
  } finally {
    clearTimeout(timer);
  }
}

interface RateLimitResponse {
  resources?: {
    core?: { limit: number; remaining: number; reset: number };
    search?: { limit: number; remaining: number; reset: number };
  };
}

interface UserResponse {
  id?: number;
  login?: string;
  name?: string;
  avatar_url?: string;
}

function scopeListFromHeader(res: Response): string[] {
  try {
    const scopes = res.headers.get("x-oauth-scopes");
    if (!scopes) return [];
    return scopes.split(",").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 验证某个 token：调用 /user 与 /rate_limit，带超时保护，返回身份与额度。
 */
export async function validateGitHubToken(
  token: string
): Promise<GitHubTokenValidationResult> {
  if (!token || !token.trim()) {
    return { valid: false, identity: null, quota: null, error: "empty token" };
  }
  const trimmed = token.trim();

  try {
    const [{ res: userRes, data: user }, { res: rlRes, data: rl }] = await Promise.all([
      rawCallWithToken<UserResponse>("/user", trimmed),
      rawCallWithToken<RateLimitResponse>("/rate_limit", trimmed),
    ]);

    if (userRes.status === 401) {
      return { valid: false, identity: null, quota: null, status: 401, error: "invalid token" };
    }
    if (!userRes.ok) {
      return {
        valid: false,
        identity: null,
        quota: null,
        status: userRes.status,
        error: `GitHub API error: ${userRes.status} ${userRes.statusText}`,
      };
    }

const identity: GitHubTokenIdentity = {
      id: user?.id != null ? String(user.id) : null,
      login: user?.login ?? null,
      name: user?.name ?? null,
      avatarUrl: user?.avatar_url ?? null,
      scopes: scopeListFromHeader(userRes),
    };

    let quota: GitHubQuotaSummary | null = null;
    if (rlRes.ok && rl) {
      const core = rl.resources?.core;
      const search = rl.resources?.search;
      quota = {
        core: {
          limit: core?.limit ?? 0,
          remaining: core?.remaining ?? 0,
          resetAt: core?.reset ? new Date(core.reset * 1000) : null,
        },
        search: {
          limit: search?.limit ?? 0,
          remaining: search?.remaining ?? 0,
          resetAt: search?.reset ? new Date(search.reset * 1000) : null,
        },
      };
    }

    return { valid: true, identity, quota };
  } catch (err) {
    return {
      valid: false,
      identity: null,
      quota: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export type { GitHubRepo, GitHubSearchResponse };
export type { GitHubRequestCategory };