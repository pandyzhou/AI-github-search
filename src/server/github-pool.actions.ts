"use server";

import { db } from "@/db";
import { githubPoolConfig, githubTokens, users } from "@/db/schema";
import { authOptions } from "@/lib/auth";
import { decryptSecret } from "@/lib/secret-crypto";
import {
  POOL_CONFIG_ID,
  PoolConfig,
  PoolTokenStatus,
  PoolTokenView,
  DEFAULT_POOL_CONFIG,
  sanitizeTokenRow,
  validateAddTokenInput,
  validatePoolConfig,
  validationToFields,
} from "@/lib/github-pool";
import { validateGitHubToken } from "@/lib/github";
import { invalidateGitHubTokenPool } from "@/lib/github-token-pool";
import { invalidateGitHubSemaphoreConfig } from "@/lib/github-semaphore";
import { upsertPoolToken } from "@/server/github-pool.service";
import { isDatabaseErrorMessage } from "@/lib/api-guard";
import { eq } from "drizzle-orm";
import { getServerSession } from "next-auth/next";
import { revalidatePath } from "next/cache";

function actionError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  if (isDatabaseErrorMessage(message)) {
    return "数据库服务暂时不可用，请检查数据库配置或迁移是否已执行。";
  }
  return message || fallback;
}

function now(): Date {
  return new Date();
}

async function getSessionUser(): Promise<{ id: string; role: "USER" | "ADMIN" } | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return null;
  // 实时查 users.role，不直接信 session
  try {
    const rows = (await db
      .select()
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1)) as Array<Record<string, unknown>>;
    const dbUser = rows[0];
    return dbUser ? { id: session.user.id, role: dbUser.role === "ADMIN" ? "ADMIN" : "USER" } : null;
  } catch {
    return null;
  }
}

/** 管理员权限断言：实时查库验证 role，非管理员抛错。 */
export async function assertAdmin(): Promise<void> {
  const user = await getSessionUser();
  if (!user || user.role !== "ADMIN") {
    throw new Error("无权访问");
  }
}

async function getCurrentAdminId(): Promise<string> {
  const user = await getSessionUser();
  if (!user || user.role !== "ADMIN") {
    throw new Error("无权访问");
  }
  return user.id;
}

/** 列出池中全部 token（脱敏）。 */
export async function listPoolTokens(): Promise<PoolTokenView[]> {
  await assertAdmin();
  const rows = (await db.select().from(githubTokens)) as Array<Record<string, unknown>>;
  return rows.map((row) => sanitizeTokenRow(row));
}

/** 读取池配置；缺省返回默认值。 */
export async function getPoolConfig(): Promise<PoolConfig> {
  await assertAdmin();
  const rows = (await db
    .select()
    .from(githubPoolConfig)
    .where(eq(githubPoolConfig.id, POOL_CONFIG_ID))
    .limit(1)) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return { ...DEFAULT_POOL_CONFIG };
  return {
    maxConcurrency:
      typeof row.maxConcurrency === "number" && row.maxConcurrency > 0
        ? Math.trunc(row.maxConcurrency)
        : DEFAULT_POOL_CONFIG.maxConcurrency,
    parallelSearchPages:
      typeof row.parallelSearchPages === "number" && row.parallelSearchPages > 0
        ? Math.trunc(row.parallelSearchPages)
        : DEFAULT_POOL_CONFIG.parallelSearchPages,
  };
}

function invalidate() {
  invalidateGitHubTokenPool();
  invalidateGitHubSemaphoreConfig();
  revalidatePath("/admin/github-pool");
}

/** 手动新增 token：验证身份与额度后 AES 加密入库，按 github user id upsert。 */
export async function addPoolTokenManual(input: { label?: string; token?: string }): Promise<PoolTokenView> {
  await assertAdmin();
  const { label, token } = validateAddTokenInput(input);
  try {
    const view = await upsertPoolToken({ token, label, source: "manual" });
    invalidate();
    return view;
  } catch (error) {
    throw new Error(actionError(error, "新增 Token 失败"));
  }
}

/** 启用/停用 token。 */
export async function setPoolTokenEnabled(id: string, enabled: boolean): Promise<void> {
  await assertAdmin();
  const trimmed = (id ?? "").trim();
  if (!trimmed) throw new Error("缺少 Token ID");
  try {
    await db
      .update(githubTokens)
      .set({ enabled: Boolean(enabled), updatedAt: now() })
      .where(eq(githubTokens.id, trimmed));
    invalidate();
  } catch (error) {
    throw new Error(actionError(error, "更新状态失败"));
  }
}

/** 删除 token。 */
export async function deletePoolToken(id: string): Promise<void> {
  await assertAdmin();
  const trimmed = (id ?? "").trim();
  if (!trimmed) throw new Error("缺少 Token ID");
  try {
    await db.delete(githubTokens).where(eq(githubTokens.id, trimmed));
    invalidate();
  } catch (error) {
    throw new Error(actionError(error, "删除 Token 失败"));
  }
}

function classifyRefreshError(message: string): PoolTokenStatus {
  const m = message.toLowerCase();
  if (m.includes("无效") || m.includes("invalid") || m.includes("401") || m.includes("解密")) {
    return "invalid";
  }
  if (m.includes("限流") || m.includes("cooldown") || m.includes("rate limit")) {
    return "cooldown";
  }
  if (m.includes("exhausted") || m.includes("配额耗尽")) {
    return "exhausted";
  }
  return "active";
}

/** 刷新单个 token 额度。 */
export async function refreshPoolToken(id: string): Promise<PoolTokenView> {
  await assertAdmin();
  const trimmed = (id ?? "").trim();
  if (!trimmed) throw new Error("缺少 Token ID");
  let row: Record<string, unknown> | null = null;
  try {
    const rows = (await db
      .select()
      .from(githubTokens)
      .where(eq(githubTokens.id, trimmed))
      .limit(1)) as Array<Record<string, unknown>>;
    row = rows[0] ?? null;
    if (!row) throw new Error("Token 不存在");
    const token = decryptSecret(row.encryptedToken as string);
    if (!token) throw new Error("Token 解密失败，请重新新增");
    const result = await validateGitHubToken(token);
    if (!result.valid) {
      throw new Error(result.error ?? (result.status === 401 ? "无效或已失效" : "验证失败"));
    }
    const fields = validationToFields(result);
    const ts = now();
    await db
      .update(githubTokens)
      .set({
        githubLogin: fields.githubLogin,
        avatarUrl: fields.avatarUrl,
        scopes: fields.scopes,
        coreLimit: fields.coreLimit,
        coreLimitRemaining: fields.coreLimitRemaining,
        coreLimitResetAt: fields.coreLimitResetAt,
        searchLimit: fields.searchLimit,
        searchLimitRemaining: fields.searchLimitRemaining,
        searchLimitResetAt: fields.searchLimitResetAt,
        lastCheckedAt: ts,
        lastError: null,
        status: "active",
        updatedAt: ts,
      })
      .where(eq(githubTokens.id, trimmed));
    invalidate();
    const updated = (await db
      .select()
      .from(githubTokens)
      .where(eq(githubTokens.id, trimmed))
      .limit(1)) as Array<Record<string, unknown>>;
    return sanitizeTokenRow(updated[0] ?? row);
  } catch (error) {
    const message = actionError(error, "刷新失败");
    const status: PoolTokenStatus = classifyRefreshError(message);
    try {
      await db
        .update(githubTokens)
        .set({ lastError: message, lastCheckedAt: now(), status, updatedAt: now() })
        .where(eq(githubTokens.id, trimmed));
      invalidateGitHubTokenPool();
    } catch {
      // ignore secondary error
    }
    throw new Error(message);
  }
}

/** 刷新全部启用的 token 额度。逐个执行，单条失败记录原因不中断。 */
export async function refreshAllPoolTokens(): Promise<{ total: number; failed: number; migrated: number }> {
  await assertAdmin();
  const all = (await db.select().from(githubTokens)) as Array<Record<string, unknown>>;
  let failed = 0;
  let migrated = 0;
  for (const row of all) {
    const id = row.id as string;
    const enabled = row.enabled == null ? true : Boolean(row.enabled);
    if (!enabled) continue;
    migrated += 1;
    try {
      await refreshPoolToken(id);
    } catch {
      failed += 1;
    }
  }
  invalidate();
  return { total: all.length, migrated, failed };
}

/** 保存池配置（maxConcurrency 1-20、parallelSearchPages 1-5）。首次 insert 用 .returning，冲突后回查更新。 */
export async function savePoolConfig(input: { maxConcurrency?: number; parallelSearchPages?: number }): Promise<PoolConfig> {
  await assertAdmin();
  const config = validatePoolConfig(input);
  const ts = now();
  try {
    const existing = (await db
      .select()
      .from(githubPoolConfig)
      .where(eq(githubPoolConfig.id, POOL_CONFIG_ID))
      .limit(1)) as Array<Record<string, unknown>>;

    if (existing.length === 0) {
      // 首次保存：insert，捕获并发冲突后回查并 update
      try {
        await db
          .insert(githubPoolConfig)
          .values({
            id: POOL_CONFIG_ID,
            maxConcurrency: config.maxConcurrency,
            parallelSearchPages: config.parallelSearchPages,
          })
          .returning();
      } catch (insertError) {
        // 可能并发 insert 导致唯一冲突；回查后更新
        const recheck = (await db
          .select()
          .from(githubPoolConfig)
          .where(eq(githubPoolConfig.id, POOL_CONFIG_ID))
          .limit(1)) as Array<Record<string, unknown>>;
        if (recheck.length === 0) {
          throw insertError;
        }
        await db
          .update(githubPoolConfig)
          .set({
            maxConcurrency: config.maxConcurrency,
            parallelSearchPages: config.parallelSearchPages,
            updatedAt: ts,
          })
          .where(eq(githubPoolConfig.id, POOL_CONFIG_ID));
      }
    } else {
      await db
        .update(githubPoolConfig)
        .set({
          maxConcurrency: config.maxConcurrency,
          parallelSearchPages: config.parallelSearchPages,
          updatedAt: ts,
        })
        .where(eq(githubPoolConfig.id, POOL_CONFIG_ID));
    }
    invalidate();
    return config;
  } catch (error) {
    throw new Error(actionError(error, "保存配置失败"));
  }
}

/** 当前管理员迁移其个人 users.github_token 到共享池，成功后清空旧字段。 */
export async function migrateLegacyAdminToken(): Promise<{
  migrated: boolean;
  message: string;
}> {
  const adminId = await getCurrentAdminId();
  try {
    const rows = (await db
      .select()
      .from(users)
      .where(eq(users.id, adminId))
      .limit(1)) as Array<Record<string, unknown>>;
    const admin = rows[0];
    if (!admin) return { migrated: false, message: "管理员账号不存在" };

    const token = decryptSecret(admin.githubToken as string);
    if (!token) return { migrated: false, message: "当前管理员没有可迁移的个人 GitHub Token" };

    const view = await upsertPoolToken({
      token,
      label: `迁移-${admin.name ?? admin.email ?? ""}`.slice(0, 80) || null,
      source: "migrated",
    });

    await db
      .update(users)
      .set({ githubToken: null })
      .where(eq(users.id, adminId));

    invalidate();
    return { migrated: true, message: `已迁移 Token（ID：${view.id}）到共享池并清空个人字段` };
  } catch (error) {
    throw new Error(actionError(error, "迁移失败"));
  }
}