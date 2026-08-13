import Link from "next/link";
import { ChevronLeft, ChevronRight, AlertCircle } from "lucide-react";
import { RepoCard } from "./RepoCard";
import type { SearchResult } from "@/types";

interface RepoListProps {
  results: SearchResult;
  searchParams: {
    q?: string;
    language?: string;
    stars?: string;
    forks?: string;
    updated?: string;
    sort?: string;
    order?: string;
  };
}

export function RepoList({ results, searchParams }: RepoListProps) {
  const totalPages = Math.ceil(results.total / results.per_page);
  const currentPage = results.page;

  const buildPageUrl = (page: number) => {
    const params = new URLSearchParams();
    Object.entries(searchParams).forEach(([key, value]) => {
      if (value && key !== "page") params.set(key, value);
    });
    params.set("page", page.toString());
    return `/search?${params.toString()}`;
  };

  return (
    <div className="space-y-3">
      {results.truncated && (
        <div
          className="flex items-start gap-2 rounded-2xl px-4 py-3"
          style={{
            background: "#FFFBEB",
            border: "1px solid #FDE68A",
            color: "#92400E",
          }}
        >
          <AlertCircle style={{ width: 16, height: 16 }} className="flex-shrink-0 mt-0.5" />
          <p className="text-xs sm:text-sm">
            GitHub 搜索结果最多仅提供前 1000 条，超出部分无法浏览。已展示当前可用的最新 1000 条结果。
          </p>
        </div>
      )}

      {results.results.map((repo) => (
        <RepoCard key={repo.full_name} repo={repo} />
      ))}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-4">
          <Link
            href={buildPageUrl(currentPage - 1)}
            className={`btn-secondary ${currentPage <= 1 ? "pointer-events-none opacity-40" : ""}`}
          >
            <ChevronLeft style={{ width: 16, height: 16 }} />
            上一页
          </Link>

          <span className="text-sm" style={{ color: "var(--color-text-muted)" }}>
            第 {currentPage} / {totalPages} 页
          </span>

          <Link
            href={buildPageUrl(currentPage + 1)}
            className={`btn-secondary ${
              currentPage >= totalPages ? "pointer-events-none opacity-40" : ""
            }`}
          >
            下一页
            <ChevronRight style={{ width: 16, height: 16 }} />
          </Link>
        </div>
      )}
    </div>
  );
}
