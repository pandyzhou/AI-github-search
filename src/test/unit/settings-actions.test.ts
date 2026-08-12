import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, memoryStorage } from "@/db";
import { users } from "@/db/schema";
import { isEncryptedSecret, decryptSecret } from "@/lib/secret-crypto";
import { getUserSettings, updateUserSettings } from "@/server/settings.actions";
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
    memoryStorage.comments = [];
    vi.clearAllMocks();
  });

  it("keeps stored GitHub secret configured without exposing it", async () => {
    const [user] = await db
      .insert(users)
      .values({
        email: "owner@example.com",
        name: "Owner",
        githubToken: "ghp_old",
      })
      .returning();
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: user.id } } as never);

    await expect(getUserSettings()).resolves.toMatchObject({
      githubToken: "",
      githubTokenConfigured: true,
    });

    const result = await updateUserSettings({
      name: "Owner",
      githubToken: "",
    });

    const stored = memoryStorage.users[0];

    expect(result.githubTokenConfigured).toBe(true);
    expect(isEncryptedSecret(stored.githubToken as string)).toBe(true);
    expect(decryptSecret(stored.githubToken as string)).toBe("ghp_old");
  });

  it("clears stored GitHub secret explicitly", async () => {
    const [user] = await db
      .insert(users)
      .values({
        email: "owner@example.com",
        name: "Owner",
        githubToken: "ghp_old",
      })
      .returning();
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: user.id } } as never);

    const result = await updateUserSettings({
      name: "Owner",
      githubToken: "",
      clearGithubToken: true,
    });

    const stored = memoryStorage.users[0];

    expect(result.githubTokenConfigured).toBe(false);
    expect(stored.githubToken).toBeNull();
  });
});