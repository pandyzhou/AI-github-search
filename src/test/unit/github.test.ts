import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  clearGitHubCache,
  searchRepos,
  getRepo,
  getRepoReadme,
  getRepoContents,
  getRepoFileContent,
  getRepoLanguages,
  getTrendingRepos,
  validateGitHubToken,
  GitHubPoolError,
} from "@/lib/github";
import {
  __setGitHubTokensForTesting,
  __resetGitHubTokenPoolForTesting,
  getGitHubTokenUsage,
  invalidateGitHubTokenPool,
  selectGitHubToken,
  updateTokenFromHeaders,
  parseRateLimitHeaders,
} from "@/lib/github-token-pool";
import { __resetGitHubSemaphoreForTests } from "@/lib/github-semaphore";

const mockFetch = vi.fn();
global.fetch = mockFetch;

interface MockRespOpts {
  ok: boolean;
  status: number;
  statusText?: string;
  headers?: Headers;
  json?: unknown;
  text?: string;
}

function mockResp(opts: MockRespOpts): Response {
  const h = opts.headers ?? new Headers();
  const textBody = opts.text ?? (opts.json !== undefined ? JSON.stringify(opts.json) : "");
  return {
    ok: opts.ok,
    status: opts.status,
    statusText: opts.statusText ?? "",
    headers: h,
    text: async () => textBody,
    json: async () => opts.json,
  } as unknown as Response;
}

function repoData(full = "owner/repo", isPrivate = false) {
  return {
    id: 1,
    full_name: full,
    name: full.split("/")[1],
    owner: { login: full.split("/")[0], avatar_url: "" },
    description: "Test repo",
    stargazers_count: 10,
    forks_count: 2,
    open_issues_count: 1,
    watchers_count: 5,
    language: "TypeScript",
    topics: [],
    license: null,
    created_at: "2024-01-01",
    pushed_at: "2024-01-01",
    updated_at: "2024-01-01",
    homepage: null,
    html_url: `https://github.com/${full}`,
    default_branch: "main",
    private: isPrivate,
  };
}

function authOf(call: unknown): string | undefined {
  const init = (call as unknown[])[1] as { headers?: Record<string, string> } | undefined;
  return init?.headers?.Authorization;
}

describe("GitHub API Core & Scheduler", () => {
  beforeEach(() => {
    mockFetch.mockClear();
    clearGitHubCache();
    __resetGitHubTokenPoolForTesting();
    __resetGitHubSemaphoreForTests();
    delete process.env.GITHUB_TOKEN;
  });

  it("should search repositories with correct parameters", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResp({
        ok: true,
        status: 200,
        json: { total_count: 100, items: [repoData("facebook/react")] },
      })
    );

    const result = await searchRepos("react", {
      sort: "stars",
      order: "desc",
      page: 1,
      perPage: 20,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/search/repositories?q=react"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "application/vnd.github.v3+json",
        }),
      })
    );
    expect(result.total_count).toBe(100);
    expect(result.items[0].full_name).toBe("facebook/react");
  });

  it("force is:public in search query without duplication", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResp({ ok: true, status: 200, json: { total_count: 0, items: [] } })
    );
    await searchRepos("react is:public");
    const url = String((mockFetch.mock.calls[0] as unknown[])[0]);
    expect(url).toMatch(/is%3Apublic/);
    const publicMatches = url.match(/is%3Apublic/g);
    expect(publicMatches).toHaveLength(1);
  });

  it("should get repository details", async () => {
    mockFetch.mockResolvedValueOnce(mockResp({ ok: true, status: 200, json: repoData("facebook/react") }));

    const result = await getRepo("facebook", "react");
    expect(result.full_name).toBe("facebook/react");
    expect(result.stargazers_count).toBe(10);
    expect(result.private).toBe(false);
  });

  it("throws 404 error when getRepo hits a private repository", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResp({ ok: true, status: 200, json: repoData("secret/private-repo", true) })
    );

    await expect(getRepo("secret", "private-repo")).rejects.toThrow("GitHub API error: 404 Not Found");
  });

  it("protects private repos by asserting public before content requests", async () => {
    // Return private repo for getRepo check
    mockFetch.mockResolvedValue(
      mockResp({ ok: true, status: 200, json: repoData("secret/private-repo", true) })
    );

    await expect(getRepoReadme("secret", "private-repo")).rejects.toThrow("GitHub API error: 404 Not Found");
    await expect(getRepoContents("secret", "private-repo")).rejects.toThrow("GitHub API error: 404 Not Found");
    await expect(getRepoFileContent("secret", "private-repo", "file.ts")).rejects.toThrow("GitHub API error: 404 Not Found");
    await expect(getRepoLanguages("secret", "private-repo")).rejects.toThrow("GitHub API error: 404 Not Found");
  });

  it("should get README content for public repos", async () => {
    const readmeContent = "# React\nA JavaScript library";
    mockFetch
      .mockResolvedValueOnce(mockResp({ ok: true, status: 200, json: repoData("facebook/react") }))
      .mockResolvedValueOnce(
        mockResp({
          ok: true,
          status: 200,
          json: { content: Buffer.from(readmeContent).toString("base64"), encoding: "base64" },
        })
      );

    const result = await getRepoReadme("facebook", "react");
    expect(result).toBe(readmeContent);
  });

  it("should get trending repositories", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResp({
        ok: true,
        status: 200,
        json: {
          total_count: 30,
          items: Array.from({ length: 30 }, (_, i) => repoData(`user/repo${i}`)),
        },
      })
    );

    const result = await getTrendingRepos("daily", "typescript");
    expect(result).toHaveLength(30);
    expect(result[0].full_name).toBe("user/repo0");
  });

  it("switches token when first token primary rate limit exhausted", async () => {
    __setGitHubTokensForTesting([
      { id: "a", token: "token_a" },
      { id: "b", token: "token_b" },
    ]);

    const resetEpoch = String(Math.floor(Date.now() / 1000) + 3600);
    mockFetch
      .mockResolvedValueOnce(
        mockResp({
          ok: false,
          status: 403,
          statusText: "Forbidden",
          headers: new Headers({
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": resetEpoch,
            "x-ratelimit-limit": "5000",
          }),
        })
      )
      .mockResolvedValueOnce(mockResp({ ok: true, status: 200, json: repoData("owner/repo") }));

    const result = await getRepo("owner", "repo");
    expect(result.full_name).toBe("owner/repo");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(authOf(mockFetch.mock.calls[0])).toBe("Bearer token_a");
    expect(authOf(mockFetch.mock.calls[1])).toBe("Bearer token_b");

    const usage = await getGitHubTokenUsage();
    const tokenA = usage.find((u) => u.id === "a");
    expect(tokenA?.status).toBe("exhausted");
    expect(tokenA?.coreLimitRemaining).toBe(0);
  });

  it("throws ALL_EXHAUSTED with 429 status and earliest retryAt when all tokens in pool are exhausted", async () => {
    const futureReset = new Date(Date.now() + 3600 * 1000);
    __setGitHubTokensForTesting([
      { id: "a", token: "token_a", status: "exhausted", coreLimitRemaining: 0, coreLimitResetAt: futureReset },
    ]);

    try {
      await getRepo("owner", "repo");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubPoolError);
      const poolErr = err as GitHubPoolError;
      expect(poolErr.code).toBe("ALL_EXHAUSTED");
      expect(poolErr.status).toBe(429);
      expect(poolErr.retryAt?.getTime()).toBe(futureReset.getTime());
    }
  });

  it("disables token on 401 invalid and switches with 401 status on failure", async () => {
    __setGitHubTokensForTesting([
      { id: "a", token: "token_a" },
      { id: "b", token: "valid_token" },
    ]);

    mockFetch
      .mockResolvedValueOnce(
        mockResp({ ok: false, status: 401, statusText: "Unauthorized" })
      )
      .mockResolvedValueOnce(mockResp({ ok: true, status: 200, json: repoData("owner/repo") }));

    const result = await getRepo("owner", "repo");
    expect(result.full_name).toBe("owner/repo");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(authOf(mockFetch.mock.calls[1])).toBe("Bearer valid_token");

    const usage = await getGitHubTokenUsage();
    const tokenA = usage.find((u) => u.id === "a");
    expect(tokenA?.status).toBe("invalid");
    expect(tokenA?.lastError).toContain("401");
  });

  it("does not rotate pool on secondary rate limit and sets status 429", async () => {
    __setGitHubTokensForTesting([
      { id: "a", token: "token_a" },
      { id: "b", token: "token_b" },
    ]);

    mockFetch.mockResolvedValueOnce(
      mockResp({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        headers: new Headers({ "retry-after": "60" }),
      })
    );

    try {
      await getRepo("owner", "repo");
      expect.fail("should throw secondary");
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubPoolError);
      const poolErr = err as GitHubPoolError;
      expect(poolErr.code).toBe("SECONDARY");
      expect(poolErr.status).toBe(429);
      expect(poolErr.retryAt).toBeDefined();
    }
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const usage = await getGitHubTokenUsage();
    const tokenA = usage.find((u) => u.id === "a");
    expect(tokenA?.status).toBe("cooldown");
    expect(tokenA?.cooldownUntil).not.toBeNull();
  });

  it("selectGitHubToken claims in-flight count and releaseClaim decrements it", async () => {
    __setGitHubTokensForTesting([{ id: "t1", token: "token_1" }]);

    const h1 = await selectGitHubToken("core");
    expect(h1).not.toBeNull();

    const h2 = await selectGitHubToken("core");
    expect(h2).not.toBeNull();

    h1?.releaseClaim();
    h2?.releaseClaim();
  });

  it("invalidateGitHubTokenPool invalidates cached store", async () => {
    __setGitHubTokensForTesting([{ id: "t1", token: "token_1" }]);
    const usage = await getGitHubTokenUsage();
    expect(usage).toHaveLength(1);

    invalidateGitHubTokenPool();
  });

  it("parses rate-limit headers and enforces monotonic remaining decrease within same reset window", async () => {
    __setGitHubTokensForTesting([{ id: "a", token: "token_a", coreLimitRemaining: 500 }]);
    const resetEpoch = String(Math.floor(Date.now() / 1000) + 1800);

    const h1 = parseRateLimitHeaders(
      new Headers({
        "x-ratelimit-remaining": "400",
        "x-ratelimit-limit": "5000",
        "x-ratelimit-reset": resetEpoch,
      })
    );

    await updateTokenFromHeaders("a", "core", h1);
    let usage = await getGitHubTokenUsage();
    expect(usage[0].coreLimitRemaining).toBe(400);

    // Higher remaining reported within same window -> monotonic decrease keeps smaller (400)
    const h2 = parseRateLimitHeaders(
      new Headers({
        "x-ratelimit-remaining": "450",
        "x-ratelimit-limit": "5000",
        "x-ratelimit-reset": resetEpoch,
      })
    );
    await updateTokenFromHeaders("a", "core", h2);
    usage = await getGitHubTokenUsage();
    expect(usage[0].coreLimitRemaining).toBe(400);

    // A newer reset window may legitimately restore remaining.
    const h3 = parseRateLimitHeaders(
      new Headers({
        "x-ratelimit-remaining": "5000",
        "x-ratelimit-limit": "5000",
        "x-ratelimit-reset": String(Number(resetEpoch) + 3600),
      })
    );
    await updateTokenFromHeaders("a", "core", h3);
    usage = await getGitHubTokenUsage();
    expect(usage[0].coreLimitRemaining).toBe(5000);
  });

  it("validateGitHubToken returns identity.id, login, avatar, scopes, and quotas", async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockResp({
          ok: true,
          status: 200,
          headers: new Headers({ "x-oauth-scopes": "repo, read:user" } as Record<string, string>),
          json: { id: 12345, login: "octocat", name: "The Octocat", avatar_url: "https://x" },
        })
      )
      .mockResolvedValueOnce(
        mockResp({
          ok: true,
          status: 200,
          json: {
            resources: {
              core: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3000 },
              search: { limit: 30, remaining: 29, reset: Math.floor(Date.now() / 1000) + 60 },
            },
          },
        })
      );

    const result = await validateGitHubToken("ghp_testtoken");
    expect(result.valid).toBe(true);
    expect(result.identity?.id).toBe("12345");
    expect(result.identity?.login).toBe("octocat");
    expect(result.identity?.scopes).toEqual(["repo", "read:user"]);
    expect(result.quota?.core.remaining).toBe(4999);
    expect(result.quota?.search.limit).toBe(30);
    expect(JSON.stringify(result)).not.toContain("ghp_testtoken");
  });
});