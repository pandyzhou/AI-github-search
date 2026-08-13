import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, memoryStorage } from "@/db";
import { users } from "@/db/schema";
import { getServerSession } from "next-auth/next";
import {
  addPoolTokenManual,
  assertAdmin,
  deletePoolToken,
  getPoolConfig,
  listPoolTokens,
  refreshAllPoolTokens,
  refreshPoolToken,
  savePoolConfig,
  setPoolTokenEnabled,
} from "@/server/github-pool.actions";
import { DEFAULT_POOL_CONFIG, POOL_CONFIG_ID } from "@/lib/github-pool";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("next-auth/next", () => ({ getServerSession: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const invalidateMock = vi.fn();
const invalidateSemaphoreMock = vi.fn();
vi.mock("@/lib/github-token-pool", () => ({
  invalidateGitHubTokenPool: () => invalidateMock(),
}));
vi.mock("@/lib/github-semaphore", () => ({
  invalidateGitHubSemaphoreConfig: () => invalidateSemaphoreMock(),
}));

function mockSession(role: "USER" | "ADMIN", id: string) {
  vi.mocked(getServerSession).mockResolvedValue({ user: { role, id } } as never);
}

async function seedUser(role: "USER" | "ADMIN", id = "admin-1", extra: Record<string, unknown> = {}) {
  await db.insert(users).values({ id, email: `${id}@x.com`, name: id, role, ...extra }).returning();
  return id;
}

describe("github-pool actions permissions (real-time DB role check)", () => {
  beforeEach(() => {
    memoryStorage.users = [];
    memoryStorage.collections = [];
    memoryStorage.favorites = [];
    memoryStorage.searchHistory = [];
    memoryStorage.githubTokens = [];
    memoryStorage.githubPoolConfig = [];
    vi.clearAllMocks();
  });

  it("assertAdmin denies when session claims ADMIN but DB role is USER", async () => {
    // session 说 ADMIN，但库里是 USER：算权限提升尝试，必须拒绝
    const uid = await seedUser("USER", "u1");
    mockSession("ADMIN", uid);
    await expect(assertAdmin()).rejects.toThrow("无权访问");
  });

  it("assertAdmin denies anonymous sessions", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null as never);
    await expect(assertAdmin()).rejects.toThrow("无权访问");
  });

  it("assertAdmin denies non-existent user even if session has id", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { role: "ADMIN", id: "nobody" } } as never);
    await expect(assertAdmin()).rejects.toThrow("无权访问");
  });

  it("assertAdmin passes only when DB role is ADMIN", async () => {
    const uid = await seedUser("ADMIN", "a1");
    mockSession("ADMIN", uid);
    await expect(assertAdmin()).resolves.toBeUndefined();
    expect(invalidateMock).not.toHaveBeenCalled();
  });

  it("listPoolTokens rejects non-admin before touching token storage", async () => {
    const uid = await seedUser("USER", "u2");
    mockSession("USER", uid);
    await expect(listPoolTokens()).rejects.toThrow("无权访问");
    expect(invalidateMock).not.toHaveBeenCalled();
  });

  it("addPoolTokenManual rejects non-admin", async () => {
    const uid = await seedUser("USER", "u3");
    mockSession("USER", uid);
    await expect(addPoolTokenManual({ token: "ghp_x" })).rejects.toThrow("无权访问");
  });

  it("savePoolConfig rejects non-admin regardless of input", async () => {
    const uid = await seedUser("USER", "u4");
    mockSession("USER", uid);
    await expect(savePoolConfig({ maxConcurrency: 5, parallelSearchPages: 2 })).rejects.toThrow("无权访问");
  });

  it("mutating actions reject non-admin", async () => {
    const uid = await seedUser("USER", "u5");
    mockSession("USER", uid);
    await expect(setPoolTokenEnabled("t", true)).rejects.toThrow("无权访问");
    await expect(deletePoolToken("t")).rejects.toThrow("无权访问");
    await expect(refreshPoolToken("t")).rejects.toThrow("无权访问");
    await expect(refreshAllPoolTokens()).rejects.toThrow("无权访问");
    await expect(getPoolConfig()).rejects.toThrow("无权访问");
  });

  it("getPoolConfig returns DEFAULT_POOL_CONFIG (4/1) when no config row exists", async () => {
    const uid = await seedUser("ADMIN", "a2");
    mockSession("ADMIN", uid);
    const cfg = await getPoolConfig();
    expect(cfg).toEqual(DEFAULT_POOL_CONFIG);
  });

  it("savePoolConfig inserts first config row with id=POOL_CONFIG_ID and returns it", async () => {
    const uid = await seedUser("ADMIN", "a3");
    mockSession("ADMIN", uid);
    const result = await savePoolConfig({ maxConcurrency: 8, parallelSearchPages: 3 });
    expect(result).toEqual({ maxConcurrency: 8, parallelSearchPages: 3 });
    // 库里确实写入了一行
    expect(memoryStorage.githubPoolConfig.length).toBe(1);
    expect(memoryStorage.githubPoolConfig[0].id).toBe(POOL_CONFIG_ID);
    expect(memoryStorage.githubPoolConfig[0].maxConcurrency).toBe(8);
    expect(memoryStorage.githubPoolConfig[0].parallelSearchPages).toBe(3);
  });

  it("savePoolConfig updates existing row instead of inserting a second one", async () => {
    const uid = await seedUser("ADMIN", "a4");
    mockSession("ADMIN", uid);
    await savePoolConfig({ maxConcurrency: 5, parallelSearchPages: 2 });
    await savePoolConfig({ maxConcurrency: 10, parallelSearchPages: 4 });
    expect(memoryStorage.githubPoolConfig.length).toBe(1);
    expect(memoryStorage.githubPoolConfig[0].maxConcurrency).toBe(10);
    expect(memoryStorage.githubPoolConfig[0].parallelSearchPages).toBe(4);
  });

  it("savePoolConfig invalidates token and semaphore config caches after write", async () => {
    const uid = await seedUser("ADMIN", "a5");
    mockSession("ADMIN", uid);
    invalidateMock.mockClear();
    invalidateSemaphoreMock.mockClear();
    await savePoolConfig({ maxConcurrency: 6, parallelSearchPages: 2 });
    expect(invalidateMock).toHaveBeenCalled();
    expect(invalidateSemaphoreMock).toHaveBeenCalled();
  });

  it("setPoolTokenEnabled calls invalidateGitHubTokenPool after update", async () => {
    const uid = await seedUser("ADMIN", "a6");
    mockSession("ADMIN", uid);
    // 手动插一条 token 入内存库
    memoryStorage.githubTokens.push({
      id: "tok-1",
      encryptedToken: "enc",
      fingerprint: "fp1",
      githubUserId: "gh1",
      enabled: true,
      status: "active",
    });
    invalidateMock.mockClear();
    await setPoolTokenEnabled("tok-1", false);
    expect(invalidateMock).toHaveBeenCalled();
    expect(memoryStorage.githubTokens[0].enabled).toBe(false);
  });

  it("deletePoolToken calls invalidateGitHubTokenPool after delete", async () => {
    const uid = await seedUser("ADMIN", "a7");
    mockSession("ADMIN", uid);
    memoryStorage.githubTokens.push({
      id: "tok-2",
      encryptedToken: "enc",
      fingerprint: "fp2",
      githubUserId: "gh2",
      enabled: true,
      status: "active",
    });
    invalidateMock.mockClear();
    await deletePoolToken("tok-2");
    expect(invalidateMock).toHaveBeenCalled();
    expect(memoryStorage.githubTokens.length).toBe(0);
  });

  it("Date fields written by setPoolTokenEnabled are Date instances or null", async () => {
    const uid = await seedUser("ADMIN", "a8");
    mockSession("ADMIN", uid);
    memoryStorage.githubTokens.push({
      id: "tok-3",
      encryptedToken: "enc",
      fingerprint: "fp3",
      githubUserId: "gh3",
      enabled: true,
      status: "active",
    });
    await setPoolTokenEnabled("tok-3", false);
    const row = memoryStorage.githubTokens[0];
    // updatedAt 应该是 Date 实例（由 now() 生成）
    if (row.updatedAt) expect(row.updatedAt).toBeInstanceOf(Date);
  });
});