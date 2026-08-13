import { createHmac } from "crypto";

/**
 * GitHub 共享账号池的纯逻辑工具：
 * - token 指纹（HMAC 去重）
 * - 输入与配置范围校验
 * - DB 记录脱敏
 * - validateGitHubToken 结果 → DB 字段转换（Date|null）
 * 不依赖 server-only，便于单元测试。
 */

export interface PoolTokenView {
  id: string;
  label: string | null;
  source: string | null;
  githubLogin: string | null;
  githubUserId: string | null;
  avatarUrl: string | null;
  enabled: boolean | null;
  status: string | null;
  scopes: string[] | null;
  coreLimitRemaining: number | null;
  coreLimit: number | null;
  coreLimitResetAt: string | null;
  searchLimitRemaining: number | null;
  searchLimit: number | null;
  searchLimitResetAt: string | null;
  cooldownUntil: string | null;
  lastUsedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
}

export interface PoolConfig {
  maxConcurrency: number;
  parallelSearchPages: number;
}

export type PoolTokenStatus = "active" | "exhausted" | "invalid" | "cooldown";

export const MAX_CONCURRENCY_MIN = 1;
export const MAX_CONCURRENCY_MAX = 20;
export const PARALLEL_SEARCH_PAGES_MIN = 1;
export const PARALLEL_SEARCH_PAGES_MAX = 5;

export const TOKEN_LABEL_MAX = 80;
export const TOKEN_MAX = 4096;

export const DEFAULT_POOL_CONFIG: PoolConfig = { maxConcurrency: 4, parallelSearchPages: 1 };
export const POOL_CONFIG_ID = 1;

function getHmacKey(): string {
  return process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? "dev-pool-key";
}

/** 计算 token 的 HMAC-SHA256 指纹，用于去重而不暴露明文。 */
export function tokenFingerprint(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) return "";
  return createHmac("sha256", getHmacKey()).update(trimmed).digest("hex").slice(0, 64);
}

/** 校验手动新增 token 输入，返回规整后的 {label, token}。 */
export function validateAddTokenInput(input: { label?: string; token?: string }): {
  label: string | null;
  token: string;
} {
  const token = (input.token ?? "").trim();
  if (!token) throw new Error("Token 不能为空");
  if (token.length > TOKEN_MAX) throw new Error("Token 过长");
  if (!/^[A-Za-z0-9_]+$/.test(token)) {
    throw new Error("Token 格式不合法，仅支持字母、数字与下划线");
  }

  const rawLabel = (input.label ?? "").trim();
  if (rawLabel.length > TOKEN_LABEL_MAX) throw new Error("标签过长");
  const label = rawLabel ? rawLabel : null;
  return { label, token };
}

/** 校验池配置范围，返回规整后的数值。 */
export function validatePoolConfig(input: {
  maxConcurrency?: number;
  parallelSearchPages?: number;
}): PoolConfig {
  const maxConcurrency = Number(input.maxConcurrency);
  if (
    !Number.isFinite(maxConcurrency) ||
    maxConcurrency < MAX_CONCURRENCY_MIN ||
    maxConcurrency > MAX_CONCURRENCY_MAX
  ) {
    throw new Error(`最大并发数需为 ${MAX_CONCURRENCY_MIN}-${MAX_CONCURRENCY_MAX} 之间的整数`);
  }
  const parallelSearchPages = Number(input.parallelSearchPages);
  if (
    !Number.isFinite(parallelSearchPages) ||
    parallelSearchPages < PARALLEL_SEARCH_PAGES_MIN ||
    parallelSearchPages > PARALLEL_SEARCH_PAGES_MAX
  ) {
    throw new Error(
      `并发搜索页数需为 ${PARALLEL_SEARCH_PAGES_MIN}-${PARALLEL_SEARCH_PAGES_MAX} 之间的整数`
    );
  }
  return {
    maxConcurrency: Math.trunc(maxConcurrency),
    parallelSearchPages: Math.trunc(parallelSearchPages),
  };
}

function toDate(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/** 脱敏：从 DB 记录中去掉密文，生成可展示对象。 */
export function sanitizeTokenRow(row: Record<string, unknown>): PoolTokenView {
  const scopesRaw = row.scopes;
  let scopes: string[] | null = null;
  if (typeof scopesRaw === "string" && scopesRaw.trim()) {
    scopes = scopesRaw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return {
    id: String(row.id ?? ""),
    label: (row.label as string) ?? null,
    source: (row.source as string) ?? null,
    githubLogin: (row.githubLogin as string) ?? null,
    githubUserId: (row.githubUserId as string) ?? null,
    avatarUrl: (row.avatarUrl as string) ?? null,
    enabled: row.enabled == null ? null : Boolean(row.enabled),
    status: (row.status as string) ?? null,
    scopes,
    coreLimit: (row.coreLimit as number) ?? null,
    coreLimitRemaining: (row.coreLimitRemaining as number) ?? null,
    coreLimitResetAt: toDate(row.coreLimitResetAt),
    searchLimit: (row.searchLimit as number) ?? null,
    searchLimitRemaining: (row.searchLimitRemaining as number) ?? null,
    searchLimitResetAt: toDate(row.searchLimitResetAt),
    cooldownUntil: toDate(row.cooldownUntil),
    lastUsedAt: toDate(row.lastUsedAt),
    lastCheckedAt: toDate(row.lastCheckedAt),
    lastError: (row.lastError as string) ?? null,
  };
}

/**
 * 将 validateGitHubToken 返回的身份+额度转换为可写入 DB 的字段对象。
 * 所有 Date 字段已转为 Date 实例或 null；scopes 为逗号分隔字符串或 null。
 */
export function validationToFields(valid: {
  identity: { id: string | null; login: string | null; avatarUrl: string | null; scopes: string[] } | null;
  quota: {
    core: { limit: number; remaining: number; resetAt: Date | null };
    search: { limit: number; remaining: number; resetAt: Date | null };
  } | null;
}) {
  const id = valid.identity?.id ?? null;
  if (!id) throw new Error("无法获取 GitHub 用户 ID");
  const scopesArr = valid.identity?.scopes ?? [];
  const q = valid.quota;
  return {
    githubUserId: id,
    githubLogin: valid.identity?.login ?? null,
    avatarUrl: valid.identity?.avatarUrl ?? null,
    scopes: scopesArr.length > 0 ? scopesArr.join(",") : null,
    coreLimit: q?.core.limit ?? null,
    coreLimitRemaining: q?.core.remaining ?? null,
    coreLimitResetAt: q?.core.resetAt instanceof Date ? q.core.resetAt : null,
    searchLimit: q?.search.limit ?? null,
    searchLimitRemaining: q?.search.remaining ?? null,
    searchLimitResetAt: q?.search.resetAt instanceof Date ? q.search.resetAt : null,
  };
}