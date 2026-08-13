"use server";

import { getCache, setCache } from "@/lib/cache";
import { repoIndex } from "@/lib/search";
import { searchRepos, getGitHubPoolConfig } from "@/lib/github";
import {
  DEFAULT_SEARCH_PAGE,
  DEFAULT_SEARCH_PER_PAGE,
  MAX_SEARCH_PAGE,
  MAX_SEARCH_PER_PAGE,
  clampInteger,
  sanitizeQualifierValue,
} from "@/lib/search-params";
import { GitHubSearchWindowError } from "@/lib/github-error";
import type { RepoItem, SearchFilters, SearchResult } from "@/types";

/** GitHub Search API 最多只返回前 1000 条结果。 */
const GITHUB_SEARCH_MAX_TOTAL = 1000;

/** parallelSearchPages 强制区间。 */
const MIN_PARALLEL_PAGES = 1;
const MAX_PARALLEL_PAGES = 5;

function githubRepoToItem(repo: {
  full_name: string;
  name: string;
  owner: { login: string };
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  watchers_count: number;
  language: string | null;
  topics: string[];
  license: { name: string } | null;
  created_at: string;
  pushed_at: string;
  updated_at: string;
  homepage: string | null;
  html_url: string;
}): RepoItem {
  return {
    full_name: repo.full_name,
    name: repo.name,
    owner: repo.owner.login,
    description: repo.description,
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    open_issues: repo.open_issues_count,
    watchers: repo.watchers_count,
    language: repo.language,
    topics: repo.topics,
    license: repo.license?.name ?? null,
    created_at: repo.created_at,
    pushed_at: repo.pushed_at,
    updated_at: repo.updated_at,
    homepage: repo.homepage,
    html_url: repo.html_url,
  };
}

function buildMeiliFilter(filters: SearchFilters): string[] {
  const conditions: string[] = [];
  const quote = (value: string) => `"${value.replace(/"/g, '\\"')}"`;

  if (filters.language?.length) {
    conditions.push(`language IN [${filters.language.map(quote).join(", ")}]`);
  }
  if (filters.stars_min !== undefined) {
    conditions.push(`stars >= ${filters.stars_min}`);
  }
  if (filters.stars_max !== undefined) {
    conditions.push(`stars <= ${filters.stars_max}`);
  }
  if (filters.forks_min !== undefined) {
    conditions.push(`forks >= ${filters.forks_min}`);
  }
  if (filters.forks_max !== undefined) {
    conditions.push(`forks <= ${filters.forks_max}`);
  }
  if (filters.pushed_after) {
    conditions.push(`pushed_at >= ${quote(filters.pushed_after)}`);
  }
  if (filters.created_after) {
    conditions.push(`created_at >= ${quote(filters.created_after)}`);
  }
  if (filters.license?.length) {
    conditions.push(`license IN [${filters.license.map(quote).join(", ")}]`);
  }
  if (filters.topic?.length) {
    conditions.push(`topics IN [${filters.topic.map(quote).join(", ")}]`);
  }
  if (filters.user) {
    conditions.push(`owner = ${quote(filters.user)}`);
  }
  if (filters.org) {
    conditions.push(`owner = ${quote(filters.org)}`);
  }

  return conditions;
}

function sanitizeFilters(filters: SearchFilters): SearchFilters {
  const nonNegative = (value: number | undefined) =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined;

  return {
    in: filters.in?.filter(
      (value) => value === "name" || value === "description" || value === "readme"
    ),
    language: filters.language?.map(sanitizeQualifierValue).filter(Boolean) as string[] | undefined,
    stars_min: nonNegative(filters.stars_min),
    stars_max: nonNegative(filters.stars_max),
    forks_min: nonNegative(filters.forks_min),
    forks_max: nonNegative(filters.forks_max),
    pushed_after: filters.pushed_after,
    created_after: filters.created_after,
    license: filters.license?.map(sanitizeQualifierValue).filter(Boolean) as string[] | undefined,
    topic: filters.topic?.map(sanitizeQualifierValue).filter(Boolean) as string[] | undefined,
    user: sanitizeQualifierValue(filters.user),
    org: sanitizeQualifierValue(filters.org),
  };
}

function buildGitHubQuery(query: string, filters: SearchFilters): string {
  const parts = [query.trim()].filter(Boolean);

  filters.in?.forEach((value) => parts.push(`in:${value}`));
  filters.language?.forEach((value) => parts.push(`language:${value}`));
  if (filters.stars_min !== undefined) parts.push(`stars:>=${filters.stars_min}`);
  if (filters.stars_max !== undefined) parts.push(`stars:<=${filters.stars_max}`);
  if (filters.forks_min !== undefined) parts.push(`forks:>=${filters.forks_min}`);
  if (filters.forks_max !== undefined) parts.push(`forks:<=${filters.forks_max}`);
  if (filters.pushed_after) parts.push(`pushed:>=${filters.pushed_after}`);
  if (filters.created_after) parts.push(`created:>=${filters.created_after}`);
  filters.license?.forEach((value) => parts.push(`license:${value}`));
  filters.topic?.forEach((value) => parts.push(`topic:${value}`));
  if (filters.user) parts.push(`user:${filters.user}`);
  if (filters.org) parts.push(`org:${filters.org}`);

  return parts.join(" ");
}

interface GitHubFallbackOptions {
  sort?: "stars" | "forks" | "updated";
  order?: "desc" | "asc";
  page: number;
  perPage: number;
  parallelPages: number;
}

/**
 * GitHub 直查 fallback：并行抓取 N 个子页，顺序合并并按 full_name 去重。
 *
 * 外层第 K 页对应 GitHub 子页 (K-1)*N+1..K*N，每页 per_page=P。
 * 受底层 github.ts 全局并发池约束。GitHub Search 最多返回前 1000 条，
 * 超出窗口的子页不会被请求；最后一个外层页可能只覆盖部分子页。
 */
async function searchGitHub(
  query: string,
  filters: SearchFilters,
  options: GitHubFallbackOptions
): Promise<SearchResult> {
  const { page: K, perPage: P, parallelPages: N } = options;
  const effectivePerPage = P * N;

  const emptyResult: SearchResult = {
    total: 0,
    page: K,
    per_page: effectivePerPage,
    results: [],
    facets: { language: [], license: [], topic: [] },
    actual_total: 0,
    truncated: false,
  };

  const githubQuery = buildGitHubQuery(query, filters);
  if (!githubQuery) {
    return emptyResult;
  }

  const startSubPage = (K - 1) * N + 1;
  // GitHub Search 硬约束：page * per_page <= 1000。
  const maxSubPage = Math.floor(GITHUB_SEARCH_MAX_TOTAL / P);

  // 外层页整体越过 1000 窗口：结构化 422，不返回假 total=0。
  if (startSubPage > maxSubPage) {
    throw new GitHubSearchWindowError(
      `GitHub 搜索结果最多仅提供前 ${GITHUB_SEARCH_MAX_TOTAL} 条，第 ${K} 页已超出可访问范围`
    );
  }

  const subPages: number[] = [];
  for (let i = 0; i < N; i++) {
    const subPage = startSubPage + i;
    if (subPage > maxSubPage) break; // 不请求超出 1000 窗口的子页
    if (subPage < 1) continue;
    subPages.push(subPage);
  }

  if (subPages.length === 0) {
    return emptyResult;
  }

  // 各子页请求由底层 github.ts 统一并发池控制。
  const responses = await Promise.all(
    subPages.map((subPage) =>
      searchRepos(githubQuery, {
        sort: options.sort,
        order: options.order,
        page: subPage,
        perPage: P,
      })
    )
  );

  // 顺序合并 + full_name 去重，保持 GitHub 排序稳定。
  const seen = new Set<string>();
  const merged: RepoItem[] = [];
  for (const resp of responses) {
    for (const item of resp.items) {
      if (seen.has(item.full_name)) continue;
      seen.add(item.full_name);
      merged.push(githubRepoToItem(item));
    }
  }

  // 用于分页展示的 total 封顶为 1000；actual_total 保留原始值并标记截断。
  const actualTotal = responses[0]?.total_count ?? 0;
  const total = Math.min(actualTotal, GITHUB_SEARCH_MAX_TOTAL);

  return {
    total,
    page: K,
    per_page: effectivePerPage,
    results: merged,
    facets: { language: [], license: [], topic: [] },
    actual_total: actualTotal,
    truncated: actualTotal > GITHUB_SEARCH_MAX_TOTAL,
  };
}

const SEARCH_CACHE_TTL_SECONDS = 300;

export async function searchRepositories(
  query: string,
  filters: SearchFilters = {},
  options: {
    sort?: "stars" | "forks" | "updated";
    order?: "desc" | "asc";
    page?: number;
    perPage?: number;
  } = {}
): Promise<SearchResult> {
  const page = clampInteger(options.page, DEFAULT_SEARCH_PAGE, 1, MAX_SEARCH_PAGE);
  const perPage = clampInteger(options.perPage, DEFAULT_SEARCH_PER_PAGE, 1, MAX_SEARCH_PER_PAGE);

  const config = await getGitHubPoolConfig();
  const parallelPages = Math.min(
    Math.max(config.parallelSearchPages, MIN_PARALLEL_PAGES),
    MAX_PARALLEL_PAGES
  );
  const effectivePerPage = perPage * parallelPages;
  const safeQuery = query.trim().slice(0, 256);
  const safeFilters = sanitizeFilters(filters);

  const cacheKey = `search:v5:public:${safeQuery}:${JSON.stringify(safeFilters)}:sort=${options.sort ?? "relevance"}:order=${options.order ?? "desc"}:page=${page}:perPage=${perPage}:n=${parallelPages}`;
  const cached = await getCache<SearchResult>(cacheKey);
  if (cached) return cached;

  const fallbackOptions: GitHubFallbackOptions = {
    sort: options.sort,
    order: options.order,
    page,
    perPage,
    parallelPages,
  };

  const githubQuery = buildGitHubQuery(safeQuery, safeFilters);

  // 1) 仅尝试 Meilisearch；失败/空命中触发一次 GitHub fallback。
  let meiliResult;
  try {
    const meiliFilters = buildMeiliFilter(safeFilters);
    const meiliSortField = options.sort === "updated" ? "updated_at" : options.sort;
    meiliResult = await repoIndex.search(safeQuery, {
      filter: meiliFilters,
      sort: meiliSortField ? [`${meiliSortField}:${options.order ?? "desc"}`] : undefined,
      attributesToSearchOn: safeFilters.in?.length ? safeFilters.in : undefined,
      // 为与 GitHub fallback 分页契约一致，每个外层页返回 P*N 条。
      limit: effectivePerPage,
      offset: (page - 1) * effectivePerPage,
    });
  } catch {
    // Meilisearch 不可用：GitHub fallback 仅执行一次，错误直接向上传播。
    const fallbackResult = await searchGitHub(safeQuery, safeFilters, fallbackOptions);
    await setCache(cacheKey, fallbackResult, SEARCH_CACHE_TTL_SECONDS);
    return fallbackResult;
  }

  const hits = (meiliResult.hits ?? []) as Array<Record<string, unknown>>;
  // 只接受明确标记为公开的索引记录；旧索引缺少 private 字段时回退 GitHub，避免可见性不明的数据进入共享缓存。
  const publicHits = hits.filter((hit) => hit.private === false);

  const results: RepoItem[] = publicHits.map((hit) => ({
    full_name: String(hit.full_name),
    name: String(hit.name),
    owner: String(hit.owner),
    description: hit.description ? String(hit.description) : null,
    stars: Number(hit.stars),
    forks: Number(hit.forks),
    open_issues: Number(hit.open_issues),
    watchers: Number(hit.watchers),
    language: hit.language ? String(hit.language) : null,
    topics: Array.isArray(hit.topics) ? hit.topics.map(String) : [],
    license: hit.license ? String(hit.license) : null,
    created_at: String(hit.created_at),
    pushed_at: String(hit.pushed_at),
    updated_at: String(hit.updated_at),
    homepage: hit.homepage ? String(hit.homepage) : null,
    html_url: String(hit.html_url),
  }));

  // Meilisearch 命中时不上 GitHub；本地索引无 1000 条限制。
  if (results.length === 0 && githubQuery) {
    const fallbackResult = await searchGitHub(safeQuery, safeFilters, fallbackOptions);
    await setCache(cacheKey, fallbackResult, SEARCH_CACHE_TTL_SECONDS);
    return fallbackResult;
  }

  const estimatedTotal = meiliResult.estimatedTotalHits ?? 0;

  const result: SearchResult = {
    total: estimatedTotal,
    page,
    per_page: effectivePerPage,
    results,
    facets: { language: [], license: [], topic: [] },
    actual_total: estimatedTotal,
    truncated: false,
  };

  await setCache(cacheKey, result, SEARCH_CACHE_TTL_SECONDS);
  return result;
}