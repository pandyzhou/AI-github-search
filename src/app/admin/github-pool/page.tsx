import { listPoolTokens, getPoolConfig } from "@/server/github-pool.actions";
import { GithubPoolManager } from "@/components/admin/GithubPoolManager";
import { KeyRound } from "lucide-react";

interface GithubPoolPageProps {
  searchParams: Promise<{ bind?: string; error?: string }>;
}

const OAUTH_ERRORS: Record<string, string> = {
  GitHubAuthCancelled: "已取消 GitHub 授权",
  MissingCode: "回调缺少授权码",
  StateInvalid: "OAuth state 校验失败，请重新授权",
  OAuthNotConfigured: "OAuth 未配置",
  TokenExchangeFailed: "Token 交换失败",
  UnknownError: "授权失败",
};

export default async function GithubPoolPage({ searchParams }: GithubPoolPageProps) {
  const query = await searchParams;
  let initialTokens: Awaited<ReturnType<typeof listPoolTokens>> = [];
  let initialConfig: Awaited<ReturnType<typeof getPoolConfig>> = {
    maxConcurrency: 3,
    parallelSearchPages: 2,
  };
  let loadError = "";
  const initialNotice = query.bind === "success"
    ? { kind: "success" as const, text: "OAuth 授权成功，Token 已加入账号池" }
    : query.error
      ? {
          kind: "error" as const,
          text: OAUTH_ERRORS[query.error] ?? `授权失败：${query.error}`,
        }
      : null;

  try {
    [initialTokens, initialConfig] = await Promise.all([listPoolTokens(), getPoolConfig()]);
  } catch (error) {
    loadError = error instanceof Error ? error.message : "加载失败";
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-6">
        <KeyRound style={{ width: 20, height: 20, color: "var(--color-text-heading)" }} />
        <h1
          className="text-lg font-semibold"
          style={{ color: "var(--color-text-heading)" }}
        >
          GitHub 账号池
        </h1>
      </div>

      {loadError ? (
        <div
          className="card p-5 text-sm"
          style={{ color: "var(--color-error)" }}
        >
          加载失败：{loadError}
        </div>
      ) : (
        <GithubPoolManager
          initialTokens={initialTokens}
          initialConfig={initialConfig}
          initialNotice={initialNotice}
        />
      )}
    </div>
  );
}