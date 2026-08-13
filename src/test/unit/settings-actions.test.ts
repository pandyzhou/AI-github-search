import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, memoryStorage } from "@/db";
import { users } from "@/db/schema";
import { clearLegacyGithubToken, getUserSettings, updateUserSettings } from "@/server/settings.actions";
import { getServerSession } from "next-auth/next";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("next-auth/next", () => ({ getServerSession: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

describe("settings actions", () => {
  beforeEach(() => {
    memoryStorage.users = [];
    memoryStorage.collections = [];
    memoryStorage.favorites = [];
    memoryStorage.searchHistory = [];
    memoryStorage.githubTokens = [];
    memoryStorage.githubPoolConfig = [];
    vi.clearAllMocks();
  });

  it("returns name + githubTokenConfigured flag (no plaintext token)", async () => {
    const [user] = await db
      .insert(users)
      .values({ email: "owner@example.com", name: "Owner", githubToken: "ghp_old" })
      .returning();
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: user.id } } as never);

    const result = await getUserSettings();
    expect(result?.name).toBe("Owner");
    expect(result?.githubTokenConfigured).toBe(true);
    // 不返回明文 token
    expect((result as Record<string, unknown>).githubToken).toBeUndefined();
  });

  it("saves name only and preserves stored github_token field", async () => {
    const [user] = await db
      .insert(users)
      .values({ email: "owner@example.com", name: "Owner", githubToken: "ghp_old" })
      .returning();
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: user.id } } as never);

    await updateUserSettings({ name: "NewName" });

    const stored = memoryStorage.users[0];
    expect(stored.name).toBe("NewName");
    // github_token 列未被 settings 改动
    expect(stored.githubToken).toBe("ghp_old");
  });

  it("clearLegacyGithubToken nullifies the github_token field only", async () => {
    const [user] = await db
      .insert(users)
      .values({ email: "owner@example.com", name: "Owner", githubToken: "ghp_old" })
      .returning();
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: user.id } } as never);

    const result = await clearLegacyGithubToken();
    expect(result.success).toBe(true);
    const stored = memoryStorage.users[0];
    expect(stored.githubToken).toBeNull();
    expect(stored.name).toBe("Owner"); // 其他字段不变
  });

  it("clearLegacyGithubToken denies anonymous users", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null as never);
    await expect(clearLegacyGithubToken()).rejects.toThrow("未登录");
  });
});