"use server";

import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { isDatabaseErrorMessage } from "@/lib/api-guard";

export interface UserSettings {
  name: string;
}

function hasLegacyGitHubToken(value: string | null | undefined) {
  return Boolean(value?.trim());
}

function toSettingsActionError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : "";
  if (isDatabaseErrorMessage(message)) {
    return "数据库服务暂时不可用，请检查 DATABASE_URL、PostgreSQL 服务或数据库迁移是否已执行。";
  }
  return message || fallback;
}

export async function getUserSettings() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    throw new Error("未登录");
  }

  try {
    const result = await db.select().from(users).where(eq(users.id, session.user.id)).limit(1);

    const user = result[0];
    if (!user) return null;

    return {
      name: user.name ?? "",
      githubTokenConfigured: hasLegacyGitHubToken(user.githubToken),
    };
  } catch (error) {
    throw new Error(toSettingsActionError(error, "获取设置失败"));
  }
}

export async function updateUserSettings(settings: UserSettings) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    throw new Error("未登录");
  }

  try {
    const existingResult = await db
      .select()
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1);
    const existingUser = existingResult[0];
    if (!existingUser) {
      throw new Error("用户不存在");
    }

    const name = settings.name.trim().slice(0, 255);

    await db
      .update(users)
      .set({
        name: name || null,
      })
      .where(eq(users.id, session.user.id));

    revalidatePath("/dashboard/settings");
    revalidatePath("/dashboard");
    return { success: true };
  } catch (error) {
    throw new Error(toSettingsActionError(error, "保存设置失败"));
  }
}

export async function clearLegacyGithubToken() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    throw new Error("未登录");
  }

  try {
    await db.update(users).set({ githubToken: null }).where(eq(users.id, session.user.id));
    revalidatePath("/dashboard/settings");
    return { success: true };
  } catch (error) {
    throw new Error(toSettingsActionError(error, "清除遗留 GitHub Token 失败"));
  }
}

export async function updateUserName(name: string) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    throw new Error("未登录");
  }

  try {
    await db
      .update(users)
      .set({ name: name || null })
      .where(eq(users.id, session.user.id));

    revalidatePath("/dashboard/settings");
    revalidatePath("/dashboard");
    return { success: true };
  } catch {
    throw new Error("保存用户名失败");
  }
}