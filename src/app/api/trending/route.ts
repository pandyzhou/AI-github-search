import { NextRequest, NextResponse } from "next/server";
import { getTrendingRepos } from "@/server/trending.actions";
import { resolveGitHubErrorStatus } from "@/lib/github-error";
import { parseTrendingRange, sanitizeQualifierValue } from "@/lib/search-params";

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const range = parseTrendingRange(searchParams.get("range"));
    const lang = sanitizeQualifierValue(searchParams.get("lang"));

    const repos = await getTrendingRepos(range, lang);

    return NextResponse.json({
      repos,
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "获取趋势失败";
    const status = resolveGitHubErrorStatus(error);
    return NextResponse.json({ error: message, repos: [] }, { status });
  }
}
