"use client";

import { useState, useTransition } from "react";
import {
  Plus,
  RefreshCw,
  Trash2,
  Power,
  Save,
  Loader2,
  Check,
  AlertCircle,
  KeyRound,
  LogIn,
  UploadCloud,
} from "lucide-react";
import { PoolConfig, PoolTokenView } from "@/lib/github-pool";
import {
  addPoolTokenManual,
  deletePoolToken,
  getPoolConfig,
  listPoolTokens,
  migrateLegacyAdminToken,
  refreshAllPoolTokens,
  refreshPoolToken,
  savePoolConfig,
  setPoolTokenEnabled,
} from "@/server/github-pool.actions";

function GithubMark({ size = 16 }: { size?: number }) {
  return (
    <svg style={{ width: size, height: size }} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

interface GithubPoolManagerProps {
  initialTokens: PoolTokenView[];
  initialConfig: PoolConfig;
  initialNotice?: Notice | null;
}

type Notice = { kind: "success" | "error" | "warn"; text: string };

const STATUS_META: Record<string, { label: string; bg: string; color: string }> = {
  active: { label: "正常", bg: "#DCFCE7", color: "#16A34A" },
  exhausted: { label: "配额耗尽", bg: "#FEF3C7", color: "#D97706" },
  invalid: { label: "无效", bg: "#FEF2F2", color: "#DC2626" },
  cooldown: { label: "限流冷却", bg: "#FEF3C7", color: "#D97706" },
};

function StatusBadge({ status, enabled }: { status: string | null; enabled: boolean | null }) {
  if (enabled === false) {
    return (
      <span
        className="inline-flex items-center gap-1 badge"
        style={{ background: "var(--color-bg-hover)", color: "var(--color-text-muted)" }}
      >
        已停用
      </span>
    );
  }
  const meta = STATUS_META[status ?? "active"] ?? STATUS_META.active;
  return (
    <span className="inline-flex items-center gap-1 badge" style={{ background: meta.bg, color: meta.color }}>
      {meta.label}
    </span>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("zh-CN");
}

function quotaCell(remaining: number | null, limit: number | null, resetAt: string | null): string {
  const r = remaining ?? "—";
  const l = limit ?? "—";
  return `${r}/${l}（${fmtDate(resetAt)}）`;
}

export function GithubPoolManager({
  initialTokens,
  initialConfig,
  initialNotice = null,
}: GithubPoolManagerProps) {
  const [tokens, setTokens] = useState<PoolTokenView[]>(initialTokens);
  const [notice, setNotice] = useState<Notice | null>(initialNotice);
  const [pending, startTransition] = useTransition();

  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");

  const [maxConcurrency, setMaxConcurrency] = useState(String(initialConfig.maxConcurrency));
  const [parallelSearchPages, setParallelSearchPages] = useState(String(initialConfig.parallelSearchPages));

  function notify(text: string, kind: Notice["kind"] = "success") {
    setNotice({ kind, text });
    setTimeout(() => setNotice(null), 3500);
  }

  async function reload() {
    try {
      const [t, c] = await Promise.all([listPoolTokens(), getPoolConfig()]);
      setTokens(t);
      setMaxConcurrency(String(c.maxConcurrency));
      setParallelSearchPages(String(c.parallelSearchPages));
    } catch (e) {
      notify(e instanceof Error ? e.message : "刷新列表失败", "error");
    }
  }

  function run(task: () => Promise<unknown>, okMsg?: string) {
    startTransition(async () => {
      try {
        await task();
        await reload();
        if (okMsg) notify(okMsg);
      } catch (e) {
        notify(e instanceof Error ? e.message : "操作失败", "error");
      }
    });
  }

  const handleAdd = () =>
    run(
      async () => {
        const added = await addPoolTokenManual({ label, token });
        setLabel("");
        setToken("");
        return added;
      },
      "Token 已新增"
    );

  const handleRefresh = (id: string) => run(() => refreshPoolToken(id), "已刷新额度");
  const handleToggle = (id: string, enabled: boolean) =>
    run(() => setPoolTokenEnabled(id, !enabled), !enabled ? "已启用" : "已停用");
  const handleDelete = (id: string, label: string | null) => {
    if (!confirm(`确认删除 ${label ?? "该"} Token？此操作不可撤销。`)) return;
    run(() => deletePoolToken(id), "已删除");
  };

  const handleRefreshAll = () =>
    run(async () => {
      const result = await refreshAllPoolTokens();
      if (result.failed > 0) {
        notify(`已刷新 ${result.migrated - result.failed}/${result.migrated}，${result.failed} 个失败`, "warn");
      } else {
        notify(`已刷新全部 ${result.migrated} 个启用 Token`, "success");
      }
    }, "");

  const handleSaveConfig = () =>
    run(
      () => savePoolConfig({ maxConcurrency: Number(maxConcurrency), parallelSearchPages: Number(parallelSearchPages) }),
      "配置已保存"
    );

  const handleMigrate = () => {
    if (!confirm("将迁移你当前管理员绑定的个人 GitHub Token 到共享池，成功后将清空个人字段。继续？")) return;
    run(async () => {
      const result = await migrateLegacyAdminToken();
      if (!result.migrated) {
        notify(result.message, "warn");
        return;
      }
      notify(result.message, "success");
    });
  };

  return (
    <div className="space-y-6">
      {notice && (
        <div
          className="flex items-center gap-2 px-4 py-3 rounded-lg text-sm"
          style={{
            background: notice.kind === "error" ? "#FEF2F2" : notice.kind === "warn" ? "#FEF3C7" : "#F0FDF4",
            color: notice.kind === "error" ? "var(--color-error)" : notice.kind === "warn" ? "#D97706" : "#16A34A",
            border: `1px solid ${notice.kind === "error" ? "#FECACA" : notice.kind === "warn" ? "#FDE68A" : "#BBF7D0"}`,
          }}
        >
          {notice.kind === "success" ? (
            <Check style={{ width: 16, height: 16 }} />
          ) : (
            <AlertCircle style={{ width: 16, height: 16 }} />
          )}
          {notice.text}
        </div>
      )}

      {/* 新增区 */}
      <div className="card overflow-hidden">
        <div
          className="flex items-center gap-2 px-5 py-3.5"
          style={{ borderBottom: "1px solid var(--color-border)" }}
        >
          <Plus style={{ width: 18, height: 18, color: "var(--color-text-body)" }} />
          <h2 className="text-sm font-semibold" style={{ color: "var(--color-text-heading)" }}>
            新增 GitHub 账号
          </h2>
        </div>
        <div className="p-5 space-y-4">
          <div
            className="p-4 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3"
            style={{ background: "var(--color-bg-page)", border: "1px solid var(--color-border)" }}
          >
            <div>
              <div className="text-sm font-semibold flex items-center gap-1.5" style={{ color: "var(--color-text-heading)" }}>
                <GithubMark size={16} />
                OAuth 一键授权新增（推荐）
              </div>
              <p className="text-xs mt-1" style={{ color: "var(--color-text-muted)" }}>
                跳转 GitHub 授权，自动验证身份与额度并加入共享池，不暴露 token 明文。
              </p>
            </div>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- OAuth 需要完整 HTTP 重定向设置 cookie */}
            <a
              href="/api/auth/github-bind"
              className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium flex-shrink-0"
              style={{ background: "var(--color-text-heading)", color: "var(--color-bg-card)" }}
            >
              <LogIn style={{ width: 14, height: 14 }} />
              前往 GitHub 授权
            </a>
          </div>

          <div className="relative flex items-center py-1">
            <div className="flex-grow border-t" style={{ borderColor: "var(--color-border)" }}></div>
            <span className="flex-shrink mx-3 text-xs" style={{ color: "var(--color-text-muted)" }}>
              或者手动输入
            </span>
            <div className="flex-grow border-t" style={{ borderColor: "var(--color-border)" }}></div>
          </div>

          <div className="grid gap-3 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
            <div>
              <label className="text-xs font-medium block mb-2" style={{ color: "var(--color-text-body)" }}>
                标签（可选）
              </label>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="如：小号 A"
                maxLength={80}
                className="input w-full"
              />
            </div>
            <div>
              <label className="text-xs font-medium block mb-2" style={{ color: "var(--color-text-body)" }}>
                GitHub Token
              </label>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                className="input w-full"
              />
            </div>
            <button
              type="button"
              onClick={handleAdd}
              disabled={pending || !token.trim()}
              className="btn-primary"
            >
              {pending ? <Loader2 style={{ width: 14, height: 14 }} className="animate-spin" /> : <Plus style={{ width: 14, height: 14 }} />}
              新增并验证
            </button>
          </div>
        </div>
      </div>

      {/* 账号列表 */}
      <div className="card overflow-hidden">
        <div
          className="flex items-center justify-between px-5 py-3.5"
          style={{ borderBottom: "1px solid var(--color-border)" }}
        >
          <div className="flex items-center gap-2">
            <KeyRound style={{ width: 18, height: 18, color: "var(--color-text-body)" }} />
            <h2 className="text-sm font-semibold" style={{ color: "var(--color-text-heading)" }}>
              账号列表（{tokens.length}）
            </h2>
          </div>
          <button type="button" onClick={handleRefreshAll} disabled={pending} className="btn-ghost text-xs">
            {pending ? <Loader2 style={{ width: 12, height: 12 }} className="animate-spin" /> : <RefreshCw style={{ width: 12, height: 12 }} />}
            刷新全部额度
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: "1px solid var(--color-border)", background: "var(--color-bg-page)" }}>
                {["账号", "来源", "状态", "Core 剩余/限额/重置", "Search 剩余/限额/重置", "最近使用/检查", "错误", "操作"].map((h) => (
                  <th
                    key={h}
                    className="px-4 py-3 text-left whitespace-nowrap"
                    style={{ color: "var(--color-text-heading)", fontWeight: "var(--font-weight-semibold)" }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id} style={{ borderBottom: "1px solid var(--color-border)" }}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {t.avatarUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={t.avatarUrl} alt={t.githubLogin ?? ""} className="h-7 w-7 rounded-full" />
                      ) : null}
                      <div>
                        <p className="font-medium" style={{ color: "var(--color-text-heading)" }}>
                          {t.githubLogin ?? "未知"}
                        </p>
                        <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                          {t.label ?? "—"}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap" style={{ color: "var(--color-text-muted)" }}>
                    {t.source ?? "—"}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <StatusBadge status={t.status} enabled={t.enabled} />
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap" style={{ color: "var(--color-text-body)" }}>
                    {quotaCell(t.coreLimitRemaining, t.coreLimit, t.coreLimitResetAt)}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap" style={{ color: "var(--color-text-body)" }}>
                    {quotaCell(t.searchLimitRemaining, t.searchLimit, t.searchLimitResetAt)}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap" style={{ color: "var(--color-text-muted)" }}>
                    <div>{fmtDate(t.lastUsedAt)}</div>
                    <div className="text-xs">{fmtDate(t.lastCheckedAt)}</div>
                  </td>
                  <td
                    className="px-4 py-3 max-w-[200px] truncate"
                    style={{ color: t.lastError ? "var(--color-error)" : "var(--color-text-muted)" }}
                    title={t.lastError ?? ""}
                  >
                    {t.lastError ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        title="刷新额度"
                        onClick={() => handleRefresh(t.id)}
                        disabled={pending}
                        className="btn-ghost"
                      >
                        <RefreshCw style={{ width: 14, height: 14 }} />
                      </button>
                      <button
                        type="button"
                        title={t.enabled === false ? "启用" : "停用"}
                        onClick={() => handleToggle(t.id, t.enabled !== false)}
                        disabled={pending}
                        className="btn-ghost"
                      >
                        <Power style={{ width: 14, height: 14 }} />
                      </button>
                      <button
                        type="button"
                        title="删除"
                        onClick={() => handleDelete(t.id, t.label)}
                        disabled={pending}
                        className="btn-danger"
                      >
                        <Trash2 style={{ width: 14, height: 14 }} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {tokens.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12">
              <KeyRound style={{ width: 32, height: 32, color: "var(--color-text-muted)" }} className="mb-3" />
              <p style={{ color: "var(--color-text-muted)" }}>账号池为空，请通过 OAuth 或手动方式新增。</p>
            </div>
          )}
        </div>
      </div>

      {/* 配置 + 迁移 */}
      <div className="grid gap-6 md:grid-cols-2">
        <div className="card overflow-hidden">
          <div
            className="flex items-center gap-2 px-5 py-3.5"
            style={{ borderBottom: "1px solid var(--color-border)" }}
          >
            <Save style={{ width: 18, height: 18, color: "var(--color-text-body)" }} />
            <h2 className="text-sm font-semibold" style={{ color: "var(--color-text-heading)" }}>
              池配置
            </h2>
          </div>
          <div className="p-5 space-y-4">
            <div>
              <label className="text-xs font-medium block mb-2" style={{ color: "var(--color-text-body)" }}>
                最大并发数（1-20）
              </label>
              <input
                type="number"
                min={1}
                max={20}
                value={maxConcurrency}
                onChange={(e) => setMaxConcurrency(e.target.value)}
                className="input w-full"
              />
            </div>
            <div>
              <label className="text-xs font-medium block mb-2" style={{ color: "var(--color-text-body)" }}>
                并发搜索页数（1-5）
              </label>
              <input
                type="number"
                min={1}
                max={5}
                value={parallelSearchPages}
                onChange={(e) => setParallelSearchPages(e.target.value)}
                className="input w-full"
              />
            </div>
            <button type="button" onClick={handleSaveConfig} disabled={pending} className="btn-primary">
              {pending ? <Loader2 style={{ width: 14, height: 14 }} className="animate-spin" /> : <Save style={{ width: 14, height: 14 }} />}
              保存配置
            </button>
          </div>
        </div>

        <div className="card overflow-hidden">
          <div
            className="flex items-center gap-2 px-5 py-3.5"
            style={{ borderBottom: "1px solid var(--color-border)" }}
          >
            <UploadCloud style={{ width: 18, height: 18, color: "var(--color-text-body)" }} />
            <h2 className="text-sm font-semibold" style={{ color: "var(--color-text-heading)" }}>
              旧 Token 迁移
            </h2>
          </div>
          <div className="p-5 space-y-3">
            <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
              将你当前管理员绑定的个人 GitHub Token 迁入共享池（来源标记为 migrated），成功后会清空个人
              users.github_token 字段，但不会删除该列。
            </p>
            <button type="button" onClick={handleMigrate} disabled={pending} className="btn-ghost">
              {pending ? <Loader2 style={{ width: 14, height: 14 }} className="animate-spin" /> : <UploadCloud style={{ width: 14, height: 14 }} />}
              迁移我的个人 Token
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}