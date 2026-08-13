import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  meiliSearch: vi.fn(),
  githubSearch: vi.fn(),
  getCache: vi.fn(),
  setCache: vi.fn(),
  getGitHubPoolConfig: vi.fn(),
}));

vi.mock("@/lib/cache", () => ({
  getCache: mocks.getCache,
  setCache: mocks.setCache,
}));

vi.mock("@/lib/search", () => ({
  repoIndex: {
    search: mocks.meiliSearch,
  },
}));

vi.mock("@/lib/github", () => ({
  searchRepos: mocks.githubSearch,
  getGitHubPoolConfig: mocks.getGitHubPoolConfig,
}));

import { searchRepositories } from "@/server/search.actions";
import { GitHubSearchWindowError } from "@/lib/github-error";

function githubRepo(overrides: Record<string, unknown> = {}) {
  return {
    full_name: "facebook/react",
    name: "react",
    owner: { login: "facebook" },
    description: "The library for web and native user interfaces.",
    stargazers_count: 245000,
    forks_count: 51000,
    open_issues_count: 1000,
    watchers_count: 245000,
    language: "JavaScript",
    topics: ["react"],
    license: { name: "MIT" },
    created_at: "2013-05-24",
    pushed_at: "2026-05-01",
    updated_at: "2026-05-01",
    homepage: "https://react.dev",
    html_url: "https://github.com/facebook/react",
    ...overrides,
  };
}

function githubResponse(items: ReturnType<typeof githubRepo>[], total_count = items.length) {
  return { total_count, items };
}

function defaultConfig(n = 1) {
  return { maxConcurrency: 4, parallelSearchPages: n };
}

describe("searchRepositories", () => {
  beforeEach(() => {
    mocks.meiliSearch.mockReset();
    mocks.githubSearch.mockReset();
    mocks.getCache.mockReset();
    mocks.setCache.mockReset();
    mocks.getGitHubPoolConfig.mockReset();
    mocks.getCache.mockResolvedValue(null);
    mocks.setCache.mockResolvedValue(undefined);
    mocks.getGitHubPoolConfig.mockResolvedValue(defaultConfig(1));
  });

  it("falls back to GitHub when Meilisearch is reachable but empty", async () => {
    mocks.meiliSearch.mockResolvedValueOnce({
      hits: [],
      estimatedTotalHits: 0,
    });
    mocks.githubSearch.mockResolvedValueOnce(githubResponse([githubRepo()]));

    const result = await searchRepositories(
      "react",
      { language: ["JavaScript"], stars_min: 1000 },
      { perPage: 2 }
    );

    expect(mocks.githubSearch).toHaveBeenCalledWith(
      "react language:JavaScript stars:>=1000",
      expect.objectContaining({ page: 1, perPage: 2 })
    );
    expect(result.total).toBe(1);
    expect(result.results[0].full_name).toBe("facebook/react");
    expect(result.per_page).toBe(2);
  });

  it("uses Meilisearch results when the local index has hits", async () => {
    mocks.meiliSearch.mockResolvedValueOnce({
      estimatedTotalHits: 1,
      hits: [
        {
          full_name: "local/repo",
          name: "repo",
          private: false,
          owner: "local",
          description: "Indexed result",
          stars: 12,
          forks: 3,
          open_issues: 1,
          watchers: 12,
          language: "TypeScript",
          topics: ["indexed"],
          license: "MIT",
          created_at: "2025-01-01",
          pushed_at: "2026-01-01",
          updated_at: "2026-01-01",
          homepage: null,
          html_url: "https://github.com/local/repo",
        },
      ],
    });

    const result = await searchRepositories("repo", {}, { perPage: 1 });

    expect(mocks.githubSearch).not.toHaveBeenCalled();
    expect(result.total).toBe(1);
    expect(result.results[0].full_name).toBe("local/repo");
    expect(result.truncated).toBe(false);
  });

  it("requests N parallel GitHub sub-pages and merges in order with dedup", async () => {
    mocks.getGitHubPoolConfig.mockResolvedValue(defaultConfig(3));
    mocks.meiliSearch.mockResolvedValueOnce({ hits: [], estimatedTotalHits: 0 });
    mocks.githubSearch
      .mockResolvedValueOnce(githubResponse([githubRepo({ full_name: "a/1" })], 1500))
      .mockResolvedValueOnce(
        githubResponse(
          [
            githubRepo({ full_name: "a/1" }),
            githubRepo({ full_name: "b/2" }),
          ],
          1500
        )
      )
      .mockResolvedValueOnce(githubResponse([githubRepo({ full_name: "c/3" })], 1500));

    const result = await searchRepositories("k", {}, { page: 1, perPage: 10 });

    // 3 sub-pages: (1-1)*3+1 .. 1*3 → pages 1,2,3
    expect(mocks.githubSearch).toHaveBeenCalledTimes(3);
    const pages = mocks.githubSearch.mock.calls.map(([, opts]) => opts.page);
    expect(pages).toEqual([1, 2, 3]);
    for (const [, opts] of mocks.githubSearch.mock.calls) {
      expect(opts.perPage).toBe(10);
    }

    // 去重后保持首次出现顺序
    expect(result.results.map((r) => r.full_name)).toEqual(["a/1", "b/2", "c/3"]);
    expect(result.per_page).toBe(30); // P*N = 10*3
    expect(result.total).toBe(1000); // capped
    expect(result.actual_total).toBe(1500);
    expect(result.truncated).toBe(true);
  });

  it("does not request GitHub sub-pages beyond the 1000-result window (partial coverage)", async () => {
    mocks.getGitHubPoolConfig.mockResolvedValue(defaultConfig(3));
    mocks.meiliSearch.mockResolvedValueOnce({ hits: [], estimatedTotalHits: 0 });
    // P=20 → maxSubPage=floor(1000/20)=50；outer page 17 → sub-pages 49,50,51 → 仅请求 49,50
    mocks.githubSearch
      .mockResolvedValueOnce(githubResponse([githubRepo({ full_name: "x/49" })], 980))
      .mockResolvedValueOnce(githubResponse([githubRepo({ full_name: "x/50" })], 980));

    const result = await searchRepositories("k", {}, { page: 17, perPage: 20 });

    expect(mocks.githubSearch).toHaveBeenCalledTimes(2);
    const pages = mocks.githubSearch.mock.calls.map(([, opts]) => opts.page);
    expect(pages).toEqual([49, 50]);
    expect(result.per_page).toBe(60); // 20*3
    expect(result.results.map((r) => r.full_name)).toEqual(["x/49", "x/50"]);
    expect(result.truncated).toBe(false); // total 980 未超窗口
  });

  it("throws a structured 422 error when outer page entirely beyond the 1000 window", async () => {
    mocks.getGitHubPoolConfig.mockResolvedValue(defaultConfig(3));
    mocks.meiliSearch.mockResolvedValue({ hits: [], estimatedTotalHits: 0 });

    // P=20 → maxSubPage=50；outer page 18 → startSubPage=(18-1)*3+1=52 > 50
    const promise = searchRepositories("k", {}, { page: 18, perPage: 20 });
    await expect(promise).rejects.toBeInstanceOf(GitHubSearchWindowError);
    await expect(promise).rejects.toMatchObject({ status: 422 });

    expect(mocks.githubSearch).not.toHaveBeenCalled();
  });

  it("runs GitHub fallback exactly once when Meilisearch throws", async () => {
    mocks.meiliSearch.mockRejectedValue(new Error("Meilisearch down"));
    mocks.githubSearch.mockResolvedValueOnce(githubResponse([githubRepo({ full_name: "g/1" })]));

    const result = await searchRepositories("k", {}, { perPage: 5 });

    expect(mocks.githubSearch).toHaveBeenCalledTimes(1);
    expect(result.results.map((r) => r.full_name)).toEqual(["g/1"]);
  });

  it("does not retry GitHub fallback on GitHubPoolError (bubbles up)", async () => {
    mocks.meiliSearch.mockResolvedValueOnce({ hits: [], estimatedTotalHits: 0 });
    const poolErr = Object.assign(
      new Error("All GitHub tokens exhausted or unavailable"),
      { status: 429, name: "GitHubPoolError" }
    );
    mocks.githubSearch.mockRejectedValueOnce(poolErr);

    await expect(searchRepositories("k", {}, { perPage: 5 })).rejects.toMatchObject({
      status: 429,
    });
    expect(mocks.githubSearch).toHaveBeenCalledTimes(1);
  });

  it("only trusts Meilisearch hits explicitly marked public", async () => {
    mocks.meiliSearch.mockResolvedValueOnce({
      estimatedTotalHits: 3,
      hits: [
        { full_name: "unknown/a", name: "a", owner: "unknown", stars: 1, forks: 0, open_issues: 0, watchers: 1, created_at: "2024-01-01", pushed_at: "2024-01-01", updated_at: "2024-01-01", html_url: "u" },
        { full_name: "priv/b", name: "b", owner: "priv", private: true, stars: 2, forks: 0, open_issues: 0, watchers: 2, created_at: "2024-01-01", pushed_at: "2024-01-01", updated_at: "2024-01-01", html_url: "u" },
        { full_name: "pub/c", name: "c", owner: "pub", private: false, stars: 3, forks: 0, open_issues: 0, watchers: 3, created_at: "2024-01-01", pushed_at: "2024-01-01", updated_at: "2024-01-01", html_url: "u" },
      ],
    });

    const result = await searchRepositories("k", {}, { perPage: 10 });

    expect(mocks.githubSearch).not.toHaveBeenCalled();
    expect(result.results.map((r) => r.full_name)).toEqual(["pub/c"]);
  });

  it("defaults to parallelPages=1 when pool config returns default", async () => {
    mocks.getGitHubPoolConfig.mockResolvedValue(defaultConfig(1));
    mocks.meiliSearch.mockResolvedValueOnce({ hits: [], estimatedTotalHits: 0 });
    mocks.githubSearch.mockResolvedValueOnce(githubResponse([githubRepo()]));

    const result = await searchRepositories("k", {}, { perPage: 10 });

    expect(mocks.githubSearch).toHaveBeenCalledTimes(1);
    expect(result.per_page).toBe(10); // P*1
  });

  it("clamps configured parallelPages to the 1..5 range", async () => {
    mocks.getGitHubPoolConfig.mockResolvedValue(defaultConfig(99));
    mocks.meiliSearch.mockResolvedValueOnce({ hits: [], estimatedTotalHits: 0 });
    mocks
      .githubSearch.mockResolvedValue(githubResponse([githubRepo({ full_name: `g/0` })]));

    await searchRepositories("k", {}, { perPage: 5 });

    // 即使池配置返回 99，单次外层页最多请求 5 个子页。
    expect(mocks.githubSearch).toHaveBeenCalledTimes(5);
  });
});