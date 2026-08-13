import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { decryptSecret, isEncryptedSecret } from "./secret-crypto";
import { getReadyRedis } from "./cache";

/**
 * 全站共享 GitHub Token 池：仓储 + 调度。
 *
 * 对齐 `@/db/schema` 导出的表：
 *   githubTokens: id | label | source | githubLogin | githubUserId | avatarUrl |
 *                 enabled | status | encryptedToken | fingerprint |
 *                 coreLimitRemaining | coreLimitResetAt |
 *                 searchLimitRemaining | searchLimitResetAt |
 *                 lastUsedAt | lastCheckedAt | lastError | updatedAt
 *   githubPoolConfig: id(=1) | maxConcurrency | parallelSearchPages | updatedAt
 */

export type GitHubTokenStatus = "active" | "exhausted" | "cooldown" | "invalid";

export type GitHubRequestCategory = "core" | "search";

export interface GitHubPoolConfig {
  maxConcurrency: number;
  parallelSearchPages: number;
}

const DEFAULT_CONFIG: GitHubPoolConfig = {
  maxConcurrency: 4,
  parallelSearchPages: 1,
};

/** 进程内 token 记录 */
export interface GitHubTokenRecord {
  id: string;
  label: string | null;
  source: string | null;
  githubLogin: string | null;
  githubUserId: string | null;
  avatarUrl: string | null;
  enabled: boolean;
  status: GitHubTokenStatus;
  encryptedToken: string;
  fingerprint: string | null;
  coreLimit: number | null;
  coreLimitRemaining: number | null;
  coreLimitResetAt: Date | null;
  searchLimit: number | null;
  searchLimitRemaining: number | null;
  searchLimitResetAt: Date | null;
  cooldownUntil: Date | null;
  lastUsedAt: Date | null;
  lastCheckedAt: Date | null;
  lastError: string | null;
  updatedAt: Date | null;
  lastUsedBy: string | null;
}

/** 调度返回的可用 token 句柄（已解密 + 带 claim 释放机制） */
export interface GitHubTokenHandle {
  id: string;
  tokenValue: string;
  label: string | null;
  releaseClaim: () => void;
}

export class GitHubPoolError extends Error {
  readonly code:
    | "POOL_EMPTY"
    | "ALL_EXHAUSTED"
    | "SECONDARY"
    | "INVALID"
    | "TIMEOUT"
    | "UPSTREAM_ERROR";
  status: number;
  retryAt?: Date;

  constructor(
    code: GitHubPoolError["code"],
    message: string,
    opts?: { status?: number; retryAt?: Date }
  ) {
    super(message);
    this.name = "GitHubPoolError";
    this.code = code;
    this.status =
      opts?.status ??
      (code === "ALL_EXHAUSTED" || code === "SECONDARY"
        ? 429
        : code === "TIMEOUT" || code === "UPSTREAM_ERROR"
        ? 503
        : code === "INVALID"
        ? 401
        : 500);
    if (opts?.retryAt) this.retryAt = opts.retryAt;
  }
}

// ---------- 防御式列访问 ----------

function getSchemaTable(name: "githubTokens" | "githubPoolConfig"): unknown {
  return (schema as Record<string, unknown>)[name];
}

const githubTokensTable = (): unknown => getSchemaTable("githubTokens");
const githubPoolConfigTable = (): unknown => getSchemaTable("githubPoolConfig");

function pick<T = unknown>(row: Record<string, unknown>, ...names: string[]): T | null {
  for (const n of names) {
    if (n in row && row[n] !== undefined) return row[n] as T;
  }
  return null;
}

function toDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === "number") {
    const ms = v > 1e12 ? v : v > 1e9 ? v * 1000 : null;
    if (ms !== null && Number.isFinite(ms)) return new Date(ms);
    return null;
  }
  if (typeof v === "string") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
    const n = Number(v);
    if (Number.isFinite(n)) {
      const ms = n > 1e12 ? n : n > 1e9 ? n * 1000 : null;
      if (ms !== null) return new Date(ms);
    }
  }
  return null;
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mapRow(row: Record<string, unknown>): GitHubTokenRecord {
  const statusRaw = pick<string>(row, "status") ?? "active";
  const status = (
    ["active", "exhausted", "cooldown", "invalid"].includes(statusRaw)
      ? statusRaw
      : "active"
  ) as GitHubTokenStatus;
  const enabledRaw = pick(row, "enabled");

  return {
    id: String(pick(row, "id") ?? ""),
    label: pick<string>(row, "label"),
    source: pick<string>(row, "source"),
    githubLogin: pick<string>(row, "githubLogin", "github_login"),
    githubUserId: pick<string>(row, "githubUserId", "github_user_id"),
    avatarUrl: pick<string>(row, "avatarUrl", "avatar_url"),
    enabled: enabledRaw === null || enabledRaw === undefined ? true : Boolean(enabledRaw),
    status,
    encryptedToken: String(pick(row, "encryptedToken", "encrypted_token", "token") ?? ""),
    fingerprint: pick<string>(row, "fingerprint"),
    coreLimit: toNum(pick(row, "coreLimit", "core_limit")),
    coreLimitRemaining: toNum(pick(row, "coreLimitRemaining", "core_limit_remaining")),
    coreLimitResetAt: toDate(pick(row, "coreLimitResetAt", "core_limit_reset_at")),
    searchLimit: toNum(pick(row, "searchLimit", "search_limit")),
    searchLimitRemaining: toNum(pick(row, "searchLimitRemaining", "search_limit_remaining")),
    searchLimitResetAt: toDate(pick(row, "searchLimitResetAt", "search_limit_reset_at")),
    cooldownUntil: toDate(pick(row, "cooldownUntil", "cooldown_until")),
    lastUsedAt: toDate(pick(row, "lastUsedAt", "last_used_at")),
    lastCheckedAt: toDate(pick(row, "lastCheckedAt", "last_checked_at")),
    lastError: pick<string>(row, "lastError", "last_error"),
    updatedAt: toDate(pick(row, "updatedAt", "updated_at")),
    lastUsedBy: null,
  };
}

// ---------- 进程内缓存 & TTL ----------

const tokenStore = new Map<string, GitHubTokenRecord>();
let storeLoaded = false;
let storeLoadedAt = 0;
let storeLoading: Promise<void> | null = null;
let localPoolVersion = 0;
const STORE_TTL_MS = 5000; // 5s 短 TTL

let configCache: GitHubPoolConfig | null = null;
let configLoadedAt = 0;
const CONFIG_TTL_MS = 60_000;

// 并发 Claim 控制
const inFlightCountMap = new Map<string, number>();

/** 手动刷新本进程池缓存（管理 Action 会调用） */
export function invalidateGitHubTokenPool(): void {
  storeLoaded = false;
  storeLoadedAt = 0;
  storeLoading = null;
  configCache = null;
  configLoadedAt = 0;

  // 跨实例通知 Redis 版本号
  void (async () => {
    try {
      const redis = await getReadyRedis();
      if (redis) {
        await redis.incr("github:pool:version");
      }
    } catch {
      // ignore
    }
  })();
}

/** 解密 token；非加密格式直接返回原值 */
export function decryptTokenValue(token: string): string {
  if (!token) return "";
  if (isEncryptedSecret(token)) return decryptSecret(token);
  return token;
}

// ---------- 仓储：配置 ----------

export async function getGitHubPoolConfig(): Promise<GitHubPoolConfig> {
  const now = Date.now();
  if (configCache && now - configLoadedAt < CONFIG_TTL_MS) {
    return configCache;
  }

  const table = githubPoolConfigTable();
  if (!table) {
    const env = readEnvConfig();
    configCache = env;
    configLoadedAt = now;
    return env;
  }

  try {
    const tableRecord = table as Record<string, unknown>;
    const rows = (await db
      .select()
      .from(table as never)
      .where(eq(tableRecord.id as never, 1 as never))
      .limit(1)) as Record<string, unknown>[];
    const row = Array.isArray(rows) ? rows[0] : undefined;
    let max = DEFAULT_CONFIG.maxConcurrency;
    let parallel = DEFAULT_CONFIG.parallelSearchPages;
    if (row) {
      const m = toNum(pick(row, "maxConcurrency", "max_concurrency"));
      const p = toNum(pick(row, "parallelSearchPages", "parallel_search_pages"));
      if (m && m > 0) max = Math.trunc(m);
      if (p && p > 0) parallel = Math.trunc(p);
    }
    const env = readEnvConfig();
    max = Math.max(1, Math.min(20, max));
    parallel = Math.max(1, Math.min(5, parallel));
    configCache = { maxConcurrency: max, parallelSearchPages: parallel || env.parallelSearchPages };
    configLoadedAt = now;
    return configCache;
  } catch {
    const env = readEnvConfig();
    configCache = env;
    configLoadedAt = now;
    return env;
  }
}

function readEnvConfig(): GitHubPoolConfig {
  const envMax = Number(process.env.GITHUB_POOL_MAX_CONCURRENCY);
  const envParallel = Number(process.env.GITHUB_POOL_PARALLEL_SEARCH_PAGES);
  return {
    maxConcurrency:
      Number.isFinite(envMax) && envMax > 0
        ? Math.max(1, Math.min(20, Math.trunc(envMax)))
        : DEFAULT_CONFIG.maxConcurrency,
    parallelSearchPages:
      Number.isFinite(envParallel) && envParallel > 0
        ? Math.max(1, Math.min(5, Math.trunc(envParallel)))
        : DEFAULT_CONFIG.parallelSearchPages,
  };
}

// ---------- 仓储：列出 ----------

export async function listGitHubTokens(): Promise<GitHubTokenRecord[]> {
  await ensureStoreLoaded();
  return Array.from(tokenStore.values());
}

async function checkRedisVersionChange(): Promise<boolean> {
  try {
    const redis = await getReadyRedis();
    if (!redis) return false;
    const verStr = await redis.get("github:pool:version");
    const v = verStr ? Number(verStr) : 0;
    if (v > localPoolVersion) {
      localPoolVersion = v;
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

async function ensureStoreLoaded(): Promise<void> {
  const now = Date.now();
  const isExpired = storeLoaded && now - storeLoadedAt > STORE_TTL_MS;
  const isRedisChanged = storeLoaded && (await checkRedisVersionChange());

  if (!storeLoaded || isExpired || isRedisChanged) {
    if (!storeLoading) {
      storeLoading = loadTokensFromDb();
    }
    await storeLoading;
  }
}

async function loadTokensFromDb(): Promise<void> {
  storeLoading = loadTokensFromDbImpl();
  try {
    await storeLoading;
  } finally {
    storeLoaded = true;
    storeLoadedAt = Date.now();
    storeLoading = null;
  }
}

async function loadTokensFromDbImpl(): Promise<void> {
  const table = githubTokensTable();
  if (!table) return;
  try {
    const rows = (await db.select().from(table as never)) as Record<string, unknown>[];
    tokenStore.clear();
    for (const row of rows) {
      const rec = mapRow(row);
      if (rec.id) tokenStore.set(rec.id, rec);
    }
  } catch {
    // schema 未就绪或表不存在：保持空池
  }
}

/** 强制从 DB 重载 */
export async function refreshGitHubTokenPool(): Promise<void> {
  invalidateGitHubTokenPool();
  await ensureStoreLoaded();
}

// ---------- 仓储：写回 ----------

function idColumnOf(table: unknown): unknown {
  return (table as Record<string, unknown> | null)?.id ?? null;
}

async function persistPatch(record: GitHubTokenRecord, patch: Record<string, unknown>): Promise<void> {
  const table = githubTokensTable();
  if (!table) return;
  const idCol = idColumnOf(table);
  const finalPatch = { ...patch, updatedAt: new Date() };
  try {
    await db
      .update(table as never)
      .set(finalPatch as never)
      .where(eq(idCol as never, record.id as never));
  } catch {
    // 写不回去也不影响本次调度
  }
}

// ---------- 调度：选 token ----------

function categoryReset(record: GitHubTokenRecord, category: GitHubRequestCategory): Date | null {
  return category === "search" ? record.searchLimitResetAt : record.coreLimitResetAt;
}

function categoryRemaining(
  record: GitHubTokenRecord,
  category: GitHubRequestCategory
): number | null {
  return category === "search" ? record.searchLimitRemaining : record.coreLimitRemaining;
}

/**
 * 校验 token 对指定 category 的可用性：
 * 1) enabled 必须为 true
 * 2) status !== invalid
 * 3) status === cooldown 时，判断 cooldownUntil 是否已到期
 * 4) primary exhaustion 按 category 独立的 remaining/reset 判断，互不阻塞：
 *    - remaining === 0 且 reset === null -> 不可用
 *    - remaining === 0 且 Date.now() < reset.getTime() -> 不可用
 *    - remaining === 0 且 Date.now() >= reset.getTime() -> 可用（已重置）
 */
function usableForCategory(
  record: GitHubTokenRecord,
  category: GitHubRequestCategory
): boolean {
  if (!record.enabled) return false;
  if (record.status === "invalid") return false;

  const now = Date.now();

  // 检查 Cooldown 状态
  if (record.status === "cooldown" && record.cooldownUntil) {
    if (now < record.cooldownUntil.getTime()) {
      return false;
    }
  }

  // 检查 Primary Rate Limit（按 category 独立）
  const remaining = categoryRemaining(record, category);
  const reset = categoryReset(record, category);

  if (remaining === 0) {
    if (!reset) return false;
    if (now < reset.getTime()) return false;
  }

  return true;
}

/** 获取指定分类最早恢复的 retryAt 时间 */
export function getEarliestRetryAt(category: GitHubRequestCategory): Date | undefined {
  const records = Array.from(tokenStore.values()).filter((r) => r.enabled && r.status !== "invalid");
  let minTime: number | null = null;
  const now = Date.now();

  for (const r of records) {
    let t: number | null = null;
    if (r.status === "cooldown" && r.cooldownUntil) {
      t = r.cooldownUntil.getTime();
    } else {
      const reset = categoryReset(r, category);
      if (reset) t = reset.getTime();
    }
    if (t !== null && t > now) {
      if (minTime === null || t < minTime) {
        minTime = t;
      }
    }
  }

  return minTime !== null ? new Date(minTime) : undefined;
}

/**
 * 选取一个可用 token 并立即 claim（更新 inFlightCountMap）：
 * 1. 过滤可用的 token 候选者
 * 2. 考虑跨实例 Redis 原子轮转与进程内在途并发数（inFlightCount），优先分派给在途数最小、最久未使用的 token
 * 3. 返回包含 releaseClaim 机制的句柄，调用方在 finally 中必须释放
 */
export async function selectGitHubToken(
  category: GitHubRequestCategory,
  opts?: { exclude?: Iterable<string> }
): Promise<GitHubTokenHandle | null> {
  await ensureStoreLoaded();
  const exclude = new Set(opts?.exclude ?? []);
  const candidates = Array.from(tokenStore.values()).filter(
    (r) => !exclude.has(r.id) && usableForCategory(r, category)
  );

  if (candidates.length === 0) return null;

  // 尝试从 Redis 获取原子轮转 index
  let rrOffset = 0;
  try {
    const redis = await getReadyRedis();
    if (redis) {
      const idx = await redis.incr("github:pool:rr_index");
      rrOffset = Math.abs(idx % candidates.length);
    }
  } catch {
    // fallback
  }

  // 计算每个候选 token 的在途并发数并排序
  const candidatesWithScore = candidates.map((r, i) => {
    const inFlight = inFlightCountMap.get(r.id) ?? 0;
    const lastUsed = r.lastUsedAt?.getTime() ?? 0;
    // 结合 inFlight 权重、最近使用时间与 round-robin 偏置
    return { record: r, inFlight, lastUsed, rrIndex: (i + rrOffset) % candidates.length };
  });

  candidatesWithScore.sort((a, b) => {
    if (a.inFlight !== b.inFlight) return a.inFlight - b.inFlight;
    if (a.lastUsed !== b.lastUsed) return a.lastUsed - b.lastUsed;
    return a.rrIndex - b.rrIndex;
  });

  const picked = candidatesWithScore[0].record;

  // 立即 Claim
  inFlightCountMap.set(picked.id, (inFlightCountMap.get(picked.id) ?? 0) + 1);

  let released = false;
  const releaseClaim = (): void => {
    if (released) return;
    released = true;
    const current = inFlightCountMap.get(picked.id) ?? 1;
    if (current <= 1) {
      inFlightCountMap.delete(picked.id);
    } else {
      inFlightCountMap.set(picked.id, current - 1);
    }
  };

  return {
    id: picked.id,
    tokenValue: decryptTokenValue(picked.encryptedToken),
    label: picked.label,
    releaseClaim,
  };
}

// ---------- 状态更新（由调度器在每次响应后调用） ----------

export interface RateLimitHeaders {
  remaining: number | null;
  limit: number | null;
  resetAt: Date | null;
  retryAfterSeconds: number | null;
  requestId: string | null;
}

/**
 * 解析响应头为通用结构（不写死特定 category）。
 */
export function parseRateLimitHeaders(headers: Headers): RateLimitHeaders {
  const read = (k: string): string | null => {
    try {
      return headers.get(k);
    } catch {
      return null;
    }
  };
  const remaining = read("x-ratelimit-remaining");
  const limit = read("x-ratelimit-limit");
  const reset = read("x-ratelimit-reset");
  const retryAfter = read("retry-after");
  const requestId = read("x-github-request-id") ?? read("request-id");
  const resetDate = reset ? new Date(Number(reset) * 1000) : null;
  const retryAfterSeconds = retryAfter ? Number(retryAfter) : null;

  return {
    remaining: remaining !== null ? Number(remaining) : null,
    limit: limit !== null ? Number(limit) : null,
    resetAt: resetDate && !Number.isNaN(resetDate.getTime()) ? resetDate : null,
    retryAfterSeconds:
      retryAfterSeconds !== null && Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null,
    requestId,
  };
}

/**
 * 响应头更新：
 * 1) 仅更新对应 category 的 Limit/Remaining/ResetAt
 * 2) 单 reset 周期内 remaining 只降不升
 * 3) 生成单一最终状态 patch，真正 await 写回 DB
 */
export async function updateTokenFromHeaders(
  tokenId: string,
  category: GitHubRequestCategory,
  headers: RateLimitHeaders
): Promise<void> {
  const record = tokenStore.get(tokenId);
  if (!record) return;

  const patch: Record<string, unknown> = {};
  const remaining = headers.remaining;
  const limit = headers.limit;
  const resetAt = headers.resetAt;

  if (category === "search") {
    const previousReset = record.searchLimitResetAt;
    const previousRemaining = record.searchLimitRemaining;
    if (limit !== null) {
      record.searchLimit = limit;
      patch.searchLimit = limit;
    }
    if (resetAt) {
      record.searchLimitResetAt = resetAt;
      patch.searchLimitResetAt = resetAt;
    }
    if (remaining !== null) {
      const sameOrOlderWindow =
        previousReset !== null &&
        resetAt !== null &&
        resetAt.getTime() <= previousReset.getTime();
      const finalRem =
        sameOrOlderWindow && previousRemaining !== null
          ? Math.min(previousRemaining, remaining)
          : remaining;
      record.searchLimitRemaining = finalRem;
      patch.searchLimitRemaining = finalRem;
    }
  } else {
    const previousReset = record.coreLimitResetAt;
    const previousRemaining = record.coreLimitRemaining;
    if (limit !== null) {
      record.coreLimit = limit;
      patch.coreLimit = limit;
    }
    if (resetAt) {
      record.coreLimitResetAt = resetAt;
      patch.coreLimitResetAt = resetAt;
    }
    if (remaining !== null) {
      const sameOrOlderWindow =
        previousReset !== null &&
        resetAt !== null &&
        resetAt.getTime() <= previousReset.getTime();
      const finalRem =
        sameOrOlderWindow && previousRemaining !== null
          ? Math.min(previousRemaining, remaining)
          : remaining;
      record.coreLimitRemaining = finalRem;
      patch.coreLimitRemaining = finalRem;
    }
  }

  // 状态判定：不将 invalid 或处于未到期 cooldown 强行改回 active
  const now = Date.now();
  if (record.status !== "invalid") {
    if (record.status === "cooldown" && record.cooldownUntil && now < record.cooldownUntil.getTime()) {
      // 保持 cooldown
    } else {
      const rem = category === "search" ? record.searchLimitRemaining : record.coreLimitRemaining;
      if (rem === 0) {
        record.status = "exhausted";
        patch.status = "exhausted";
      } else {
        record.status = "active";
        patch.status = "active";
      }
    }
  }

  record.lastUsedAt = new Date();
  record.lastCheckedAt = new Date();
  patch.lastUsedAt = record.lastUsedAt;
  patch.lastCheckedAt = record.lastCheckedAt;

  await persistPatch(record, patch);
}

// ---------- 事件标记 ----------

export function markTokenUse(tokenId: string, usedBy: string): void {
  const record = tokenStore.get(tokenId);
  if (!record) return;
  record.lastUsedAt = new Date();
  record.lastCheckedAt = new Date();
  record.lastUsedBy = usedBy;
  void persistPatch(record, { lastUsedAt: record.lastUsedAt, lastCheckedAt: record.lastCheckedAt });
}

export function markTokenInvalid(tokenId: string, reason: string): void {
  const record = tokenStore.get(tokenId);
  if (!record) return;
  record.status = "invalid";
  record.lastError = reason;
  record.lastCheckedAt = new Date();
  const patch: Record<string, unknown> = {
    status: "invalid",
    lastError: reason,
    lastCheckedAt: record.lastCheckedAt,
  };
  void persistPatch(record, patch);
}

export function markTokenExhausted(
  tokenId: string,
  category: GitHubRequestCategory,
  resetAt: Date | null
): void {
  const record = tokenStore.get(tokenId);
  if (!record) return;
  record.status = "exhausted";
  if (category === "search") {
    record.searchLimitRemaining = 0;
    record.searchLimitResetAt = resetAt;
  } else {
    record.coreLimitRemaining = 0;
    record.coreLimitResetAt = resetAt;
  }
  const resetCol = category === "search" ? "searchLimitResetAt" : "coreLimitResetAt";
  const remCol = category === "search" ? "searchLimitRemaining" : "coreLimitRemaining";
  const patch: Record<string, unknown> = {
    status: "exhausted",
    [remCol]: 0,
    [resetCol]: resetAt,
  };
  void persistPatch(record, patch);
}

export function markTokenCooldown(
  tokenId: string,
  _category: GitHubRequestCategory,
  cooldownUntil: Date
): void {
  const record = tokenStore.get(tokenId);
  if (!record) return;
  record.status = "cooldown";
  record.cooldownUntil = cooldownUntil;
  const patch: Record<string, unknown> = {
    status: "cooldown",
    cooldownUntil,
  };
  void persistPatch(record, patch);
}

// ---------- 展示信息 ----------

export interface GitHubTokenUsage {
  id: string;
  label: string | null;
  githubLogin: string | null;
  enabled: boolean;
  status: GitHubTokenStatus;
  coreLimit: number | null;
  coreLimitRemaining: number | null;
  coreLimitResetAt: Date | null;
  searchLimit: number | null;
  searchLimitRemaining: number | null;
  searchLimitResetAt: Date | null;
  cooldownUntil: Date | null;
  lastUsedAt: Date | null;
  lastCheckedAt: Date | null;
  lastError: string | null;
}

function toUsage(r: GitHubTokenRecord): GitHubTokenUsage {
  return {
    id: r.id,
    label: r.label,
    githubLogin: r.githubLogin,
    enabled: r.enabled,
    status: r.status,
    coreLimit: r.coreLimit,
    coreLimitRemaining: r.coreLimitRemaining,
    coreLimitResetAt: r.coreLimitResetAt,
    searchLimit: r.searchLimit,
    searchLimitRemaining: r.searchLimitRemaining,
    searchLimitResetAt: r.searchLimitResetAt,
    cooldownUntil: r.cooldownUntil,
    lastUsedAt: r.lastUsedAt,
    lastCheckedAt: r.lastCheckedAt,
    lastError: r.lastError,
  };
}

export async function getGitHubTokenUsage(): Promise<GitHubTokenUsage[]> {
  await ensureStoreLoaded();
  return Array.from(tokenStore.values()).map(toUsage);
}

// ---------- 测试支持 ----------

/** 仅供测试：直接注入 token 列表，绕过 DB */
export function __setGitHubTokensForTesting(
  tokens: Partial<GitHubTokenRecord>[]
): void {
  tokenStore.clear();
  inFlightCountMap.clear();
  for (const t of tokens) {
    const record: GitHubTokenRecord = {
      id: t.id ?? `test-${Math.random().toString(36).slice(2)}`,
      label: t.label ?? null,
      source: t.source ?? null,
      githubLogin: t.githubLogin ?? null,
      githubUserId: t.githubUserId ?? null,
      avatarUrl: t.avatarUrl ?? null,
      enabled: t.enabled ?? true,
      status: (t.status as GitHubTokenStatus) ?? "active",
      encryptedToken: t.encryptedToken ?? (t as Record<string, unknown>).token as string ?? "test-token",
      fingerprint: t.fingerprint ?? null,
      coreLimit: t.coreLimit ?? null,
      coreLimitRemaining: t.coreLimitRemaining ?? null,
      coreLimitResetAt: t.coreLimitResetAt ?? null,
      searchLimit: t.searchLimit ?? null,
      searchLimitRemaining: t.searchLimitRemaining ?? null,
      searchLimitResetAt: t.searchLimitResetAt ?? null,
      cooldownUntil: t.cooldownUntil ?? null,
      lastUsedAt: t.lastUsedAt ?? null,
      lastCheckedAt: t.lastCheckedAt ?? null,
      lastError: t.lastError ?? null,
      updatedAt: null,
      lastUsedBy: null,
    };
    tokenStore.set(record.id, record);
  }
  storeLoaded = true;
  storeLoadedAt = Date.now();
  storeLoading = null;
}

/** 仅供测试：清空状态 */
export function __resetGitHubTokenPoolForTesting(): void {
  tokenStore.clear();
  inFlightCountMap.clear();
  storeLoaded = false;
  storeLoadedAt = 0;
  storeLoading = null;
  configCache = null;
  configLoadedAt = 0;
  localPoolVersion = 0;
}