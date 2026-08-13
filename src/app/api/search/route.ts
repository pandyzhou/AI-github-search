import { NextRequest, NextResponse } from "next/server";
import { searchRepositories } from "@/server/search.actions";
import { buildSearchRequest } from "@/lib/search-request";
import { resolveGitHubErrorStatus } from "@/lib/github-error";

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const searchRequest = buildSearchRequest(
      {
        q: searchParams.get("q"),
        language: searchParams.get("language"),
        stars: searchParams.get("stars"),
        forks: searchParams.get("forks"),
        updated: searchParams.get("updated"),
        sort: searchParams.get("sort"),
        order: searchParams.get("order"),
        page: searchParams.get("page"),
        per_page: searchParams.get("per_page"),
      },
      { includePerPage: true }
    );

    const result = await searchRepositories(searchRequest.searchQuery, searchRequest.filters, {
      sort: searchRequest.sort,
      order: searchRequest.order,
      page: searchRequest.page,
      perPage: searchRequest.perPage,
    });

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "搜索失败";
    const status = resolveGitHubErrorStatus(error);
    return NextResponse.json(
      {
        error: message,
        total: 0,
        page: 1,
        per_page: 20,
        results: [],
        facets: { language: [], license: [], topic: [] },
      },
      { status }
    );
  }
}