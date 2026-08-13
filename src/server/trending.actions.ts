"use server";

import { searchRepos } from "@/lib/github";

export interface TrendingRepo {
  full_name: string;
  name: string;
  owner: string;
  description: string | null;
  language: string | null;
  stars: number;
  forks: number;
  pushed_at: string;
  created_at: string;
  updated_at: string;
  topics: string[];
  license: string | null;
  homepage: string | null;
  open_issues: number;
  watchers: number;
  trend_score: number;
  estimated_new_stars: number;
}

/**
 * 保留原有 date period 语义：
 * - daily：今天 00:00 起
 * - weekly：本周一 00:00 起
 * - monthly：本月 1 日 00:00 起
 */
function getStartDate(range: "daily" | "weekly" | "monthly"): string {
  const now = new Date();
  switch (range) {
    case "daily":
      now.setHours(0, 0, 0, 0);
      break;
    case "weekly":
      now.setDate(now.getDate() - ((now.getDay() + 6) % 7));
      now.setHours(0, 0, 0, 0);
      break;
    case "monthly":
    default:
      now.setDate(1);
      now.setHours(0, 0, 0, 0);
      break;
  }
  return now.toISOString().split("T")[0];
}

const PERIOD_MULTIPLIER: Record<"daily" | "weekly" | "monthly", number> = {
  daily: 7,
  weekly: 1,
  monthly: 0.25,
};

export async function getTrendingRepos(
  range: "daily" | "weekly" | "monthly" = "weekly",
  language?: string
): Promise<TrendingRepo[]> {
  try {
    const dateStr = getStartDate(range);

    let query = `created:>=${dateStr}`;
    if (language) {
      query += ` language:${language}`;
    }

    // 使用统一 github.ts 搜索入口，受共享 token 池与全局并发控制。
    const data = await searchRepos(query, {
      sort: "stars",
      order: "desc",
      page: 1,
      perPage: 30,
    });

    const items = data.items ?? [];
    const maxStars = Math.max(
      ...items.map((i) => i.stargazers_count || 0),
      1
    );

    const multiplier = PERIOD_MULTIPLIER[range];

    return items.map((item) => {
      const stars = item.stargazers_count || 0;
      const trendScore = Math.round((stars / maxStars) * 100);

      // 确定性估算：基于 stars 与周期倍率，避免随机导致缓存结果漂移。
      const estimatedNewStars = Math.round(stars * multiplier * 0.5);

      return {
        full_name: item.full_name || "",
        name: item.name || "",
        owner: item.owner?.login || "",
        description: item.description ?? null,
        language: item.language ?? null,
        stars,
        forks: item.forks_count || 0,
        pushed_at: item.pushed_at || "",
        created_at: item.created_at || "",
        updated_at: item.updated_at || "",
        topics: item.topics || [],
        license: item.license?.name ?? null,
        homepage: item.homepage ?? null,
        open_issues: item.open_issues_count || 0,
        watchers: item.watchers_count || 0,
        trend_score: trendScore,
        estimated_new_stars: estimatedNewStars,
      };
    });
  } catch {
    return [];
  }
}