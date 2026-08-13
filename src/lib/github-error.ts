/**
 * 通用错误 → HTTP 状态码映射。
 *
 * 底层 GitHub token 池（github.ts）抛出的 GitHubPoolError / GitHubError
 * 均带 `status` 字段。其它错误按消息特征归为：
 * - 全池耗尽 / 速率限制 → 429
 * - 暂时不可用 / 无可用 token → 503
 * - 其余 → fallback（默认 500）
 */
export function resolveGitHubErrorStatus(error: unknown, fallback = 500): number {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status: unknown }).status;
    const numeric = typeof status === "number" ? status : Number(status);
    if (Number.isFinite(numeric) && numeric >= 400 && numeric < 600) {
      return numeric;
    }
  }

  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error ?? "").toLowerCase();

  if (
    message.includes("pool exhausted") ||
    message.includes("rate limit") ||
    message.includes("429")
  ) {
    return 429;
  }

  if (
    message.includes("unavailable") ||
    message.includes("no available token") ||
    message.includes("no token available") ||
    message.includes("503") ||
    message.includes("service unavailable")
  ) {
    return 503;
  }

  return fallback;
}

/**
 * GitHub Search 1000 条窗口：外层页完全越过可用窗口时抛出的结构化错误。
 * 路由通过 resolveGitHubErrorStatus 提取 status=422。
 */
export class GitHubSearchWindowError extends Error {
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = "GitHubSearchWindowError";
  }
}