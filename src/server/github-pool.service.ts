import "server-only";

import { db } from "@/db";
import { githubTokens } from "@/db/schema";
import { encryptSecret } from "@/lib/secret-crypto";
import { tokenFingerprint, validationToFields } from "@/lib/github-pool";
import { validateGitHubToken } from "@/lib/github";
import { invalidateGitHubTokenPool } from "@/lib/github-token-pool";
import { eq } from "drizzle-orm";
import type { PoolTokenView } from "@/lib/github-pool";
import { sanitizeTokenRow } from "@/lib/github-pool";

const OAUTH_TIMEOUT_MS = 15_000;

function now(): Date {
  return new Date();
}

/**
 * 用统一 validateGitHubToken 验证 token，返回身份+额度+指纹。
 * 失败抛出中文错误。
 */
export async function verifyAndPrepareToken(token: string): Promise<{
  encryptedToken: string;
  fingerprint: string;
  fields: ReturnType<typeof validationToFields>;
}> {
  const result = await validateGitHubToken(token);
  if (!result.valid) {
    if (result.status === 401) throw new Error("Token 无效或已失效");
    throw new Error(result.error ?? "GitHub 身份验证失败");
  }
  if (!result.identity?.id) throw new Error("无法获取 GitHub 用户 ID");

  const fields = validationToFields(result);
  const fingerprint = tokenFingerprint(token);
  if (!fingerprint) throw new Error("Token 指纹生成失败");
  const encryptedToken = encryptSecret(token);
  return { encryptedToken, fingerprint, fields };
}

interface UpsertInput {
  token: string;
  label: string | null;
  source: string;
  enabled?: boolean;
}

/**
 * 共享 upsert：按 github user id 更新（enabled=true/status active/保存 limit/scopes），
 * 否则按指纹去重后插入。返回脱敏视图。
 */
export async function upsertPoolToken(input: UpsertInput): Promise<PoolTokenView> {
  const { encryptedToken, fingerprint, fields } = await verifyAndPrepareToken(input.token);
  const ts = now();

  const existingByUser = (await db
    .select()
    .from(githubTokens)
    .where(eq(githubTokens.githubUserId, fields.githubUserId))
    .limit(1)) as Array<Record<string, unknown>>;

  if (existingByUser.length > 0) {
    const existing = existingByUser[0];
    await db
      .update(githubTokens)
      .set({
        encryptedToken,
        fingerprint,
        label: input.label ?? (existing.label as string | null),
        source: input.source,
        githubLogin: fields.githubLogin,
        avatarUrl: fields.avatarUrl,
        scopes: fields.scopes,
        enabled: true,
        status: "active",
        lastError: null,
        coreLimit: fields.coreLimit,
        coreLimitRemaining: fields.coreLimitRemaining,
        coreLimitResetAt: fields.coreLimitResetAt,
        searchLimit: fields.searchLimit,
        searchLimitRemaining: fields.searchLimitRemaining,
        searchLimitResetAt: fields.searchLimitResetAt,
        lastCheckedAt: ts,
        updatedAt: ts,
      })
      .where(eq(githubTokens.id, existing.id as string));
    invalidateGitHubTokenPool();
    const updated = (await db
      .select()
      .from(githubTokens)
      .where(eq(githubTokens.id, existing.id as string))
      .limit(1)) as Array<Record<string, unknown>>;
    return sanitizeTokenRow(updated[0] ?? existing);
  }

  const existingByFp = (await db
    .select()
    .from(githubTokens)
    .where(eq(githubTokens.fingerprint, fingerprint))
    .limit(1)) as Array<Record<string, unknown>>;
  if (existingByFp.length > 0) {
    throw new Error("该 GitHub Token 已存在于池中");
  }

  const inserted = (await db
    .insert(githubTokens)
    .values({
      label: input.label,
      source: input.source,
      githubUserId: fields.githubUserId,
      githubLogin: fields.githubLogin,
      avatarUrl: fields.avatarUrl,
      encryptedToken,
      fingerprint,
      enabled: input.enabled ?? true,
      status: "active",
      scopes: fields.scopes,
      coreLimit: fields.coreLimit,
      coreLimitRemaining: fields.coreLimitRemaining,
      coreLimitResetAt: fields.coreLimitResetAt,
      searchLimit: fields.searchLimit,
      searchLimitRemaining: fields.searchLimitRemaining,
      searchLimitResetAt: fields.searchLimitResetAt,
      lastCheckedAt: ts,
      lastUsedAt: null,
      lastError: null,
    })
    .returning()) as Array<Record<string, unknown>>;

  invalidateGitHubTokenPool();
  return sanitizeTokenRow(inserted[0]);
}

/** OAuth 授权后入库：供 callback 路由调用，不作为公开 server action。 */
export async function addPoolTokenFromOAuthService(token: string): Promise<PoolTokenView> {
  const clean = token.trim();
  if (!clean) throw new Error("Token 不能为空");
  return upsertPoolToken({ token: clean, label: null, source: "oauth", enabled: true });
}

/** 带超时的 OAuth token exchange。 */
export async function exchangeOAuthCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<{ accessToken: string; error?: undefined } | { accessToken: null; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OAUTH_TIMEOUT_MS);
  try {
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
      signal: controller.signal,
    });
    const data = (await res.json()) as { access_token?: string; error?: string };
    if (!res.ok || !data.access_token) {
      return { accessToken: null, error: data.error ?? "TokenExchangeFailed" };
    }
    return { accessToken: data.access_token };
  } catch (err) {
    const msg = err instanceof Error && err.name === "AbortError" ? "OAuth 交换超时" : "UnknownError";
    return { accessToken: null, error: msg };
  } finally {
    clearTimeout(timer);
  }
}