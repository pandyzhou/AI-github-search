"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import {
  User,
  Key,
  Globe,
  Save,
  Check,
  AlertCircle,
  Loader2,
  Trash2,
} from "lucide-react";
import { SignOutButton } from "@/components/dashboard/SignOutButton";
import { updateUserSettings } from "@/server/settings.actions";

interface Settings {
  name: string;
  githubToken: string;
  githubTokenConfigured?: boolean;
  clearGithubToken?: boolean;
}

interface SettingsFormProps {
  initialSettings: Settings;
}

export function SettingsForm({ initialSettings }: SettingsFormProps) {
  const [settings, setSettings] = useState<Settings>(initialSettings);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");
  const [saveMessage, setSaveMessage] = useState("");
  const searchParams = useSearchParams();

  useEffect(() => {
    const bind = searchParams.get("bind");
    const error = searchParams.get("error");
    if (bind === "success") {
      setSaveStatus("success");
      setSaveMessage("已成功通过 GitHub 一键授权绑定 Token！");
      setSettings((prev) => ({ ...prev, githubTokenConfigured: true }));
      setTimeout(() => setSaveStatus("idle"), 4000);
    } else if (error) {
      setSaveStatus("error");
      setSaveMessage(`授权失败: ${error}`);
    }
  }, [searchParams]);

  const handleSave = async () => {
    setSaving(true);
    setSaveStatus("idle");
    setSaveMessage("");

    try {
      const result = await updateUserSettings(settings);
      setSettings((prev) => ({
        ...prev,
        githubToken: "",
        githubTokenConfigured: result.githubTokenConfigured,
        clearGithubToken: false,
      }));
      setSaveStatus("success");
      setSaveMessage("设置已保存");
      setTimeout(() => setSaveStatus("idle"), 3000);
    } catch (err) {
      setSaveStatus("error");
      setSaveMessage(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const clearGitHubToken = () => {
    setSettings((prev) => ({
      ...prev,
      githubToken: "",
      githubTokenConfigured: false,
      clearGithubToken: true,
    }));
  };

  return (
    <div className="space-y-4">
      {/* Personal Info */}
      <div className="card overflow-hidden">
        <div
          className="flex items-center gap-2 px-5 py-3.5"
          style={{ borderBottom: "1px solid var(--color-border)" }}
        >
          <User style={{ width: 18, height: 18, color: "var(--color-text-body)" }} />
          <h2
            className="text-sm"
            style={{
              color: "var(--color-text-heading)",
              fontWeight: "var(--font-weight-semibold)",
            }}
          >
            个人信息
          </h2>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label
              className="text-xs font-medium block mb-2"
              style={{ color: "var(--color-text-body)" }}
            >
              用户名
            </label>
            <input
              type="text"
              value={settings.name}
              onChange={(e) => setSettings((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="输入你的用户名"
              className="input w-full"
            />
          </div>
        </div>
      </div>

      {/* GitHub Token */}
      <div className="card overflow-hidden">
        <div
          className="flex items-center gap-2 px-5 py-3.5"
          style={{ borderBottom: "1px solid var(--color-border)" }}
        >
          <Globe style={{ width: 18, height: 18, color: "var(--color-text-body)" }} />
          <h2
            className="text-sm"
            style={{
              color: "var(--color-text-heading)",
              fontWeight: "var(--font-weight-semibold)",
            }}
          >
            GitHub 配置
          </h2>
        </div>
        <div className="p-5 space-y-4">
          {/* Quick OAuth Bind */}
          <div
            className="p-4 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3"
            style={{
              background: "var(--color-bg-page)",
              border: "1px solid var(--color-border)",
            }}
          >
            <div>
              <div className="text-sm font-semibold flex items-center gap-1.5" style={{ color: "var(--color-text-heading)" }}>
                <svg style={{ width: 16, height: 16 }} viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
                一键授权绑定 (推荐)
              </div>
              <p className="text-xs mt-1" style={{ color: "var(--color-text-muted)" }}>
                无需手动复制粘贴 Token，点击前往 GitHub 授权即可自动获取并保存密钥。
              </p>
            </div>
            <a
              href="/api/auth/github-bind"
              className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium transition-colors flex-shrink-0"
              style={{
                background: "var(--color-text-heading)",
                color: "var(--color-bg-card)",
              }}
            >
              <svg style={{ width: 14, height: 14 }} viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
              {settings.githubTokenConfigured ? "重新授权 GitHub 账号" : "一键授权 GitHub 账号"}
            </a>
          </div>

          <div className="relative flex items-center py-1">
            <div className="flex-grow border-t" style={{ borderColor: "var(--color-border)" }}></div>
            <span className="flex-shrink mx-3 text-xs" style={{ color: "var(--color-text-muted)" }}>或者手动输入</span>
            <div className="flex-grow border-t" style={{ borderColor: "var(--color-border)" }}></div>
          </div>

          <div>
            <label
              className="text-xs font-medium block mb-2"
              style={{ color: "var(--color-text-body)" }}
            >
              <Key style={{ width: 12, height: 12, display: "inline", marginRight: 4 }} />
              手动输入 GitHub Token
            </label>
            <input
              type="password"
              value={settings.githubToken}
              onChange={(e) =>
                setSettings((prev) => ({
                  ...prev,
                  githubToken: e.target.value,
                  clearGithubToken: false,
                }))
              }
              placeholder={
                settings.githubTokenConfigured ? "已配置，留空保持不变" : "ghp_xxxxxxxxxxxxxxxxxxxx"
              }
              className="input w-full"
            />
            {settings.githubTokenConfigured && (
              <button type="button" onClick={clearGitHubToken} className="btn-danger mt-2 text-xs">
                <Trash2 style={{ width: 12, height: 12 }} />
                清除 Token
              </button>
            )}
            <p className="mt-1.5 text-xs" style={{ color: "var(--color-text-muted)" }}>
              配置 GitHub Personal Access Token 可将 API 速率限制从每小时 60 次提升至 5000 次。
              {settings.githubTokenConfigured ? " 当前已配置，输入新 Token 可替换。" : ""}
              {settings.clearGithubToken ? " 保存后将删除当前 Token。" : ""}
              <a
                href="https://github.com/settings/tokens"
                target="_blank"
                rel="noopener noreferrer"
                className="ml-1"
                style={{ color: "var(--color-primary)" }}
              >
                去获取 →
              </a>
            </p>
          </div>
        </div>
      </div>

      {/* Save Button & Status */}
      <div className="flex items-center gap-3">
        <button type="button" onClick={handleSave} disabled={saving} className="btn-primary">
          {saving ? (
            <Loader2 style={{ width: 14, height: 14 }} className="animate-spin" />
          ) : (
            <Save style={{ width: 14, height: 14 }} />
          )}
          保存设置
        </button>

        {saveStatus === "success" && (
          <div
            className="flex items-center gap-1.5 text-sm"
            style={{ color: "var(--color-success)" }}
          >
            <Check style={{ width: 14, height: 14 }} />
            {saveMessage}
          </div>
        )}

        {saveStatus === "error" && (
          <div
            className="flex items-center gap-1.5 text-sm"
            style={{ color: "var(--color-error)" }}
          >
            <AlertCircle style={{ width: 14, height: 14 }} />
            {saveMessage}
          </div>
        )}
      </div>

      {/* Security */}
      <div className="card overflow-hidden">
        <div
          className="flex items-center gap-2 px-5 py-3.5"
          style={{ borderBottom: "1px solid var(--color-border)" }}
        >
          <Key style={{ width: 18, height: 18, color: "var(--color-text-body)" }} />
          <h2
            className="text-sm"
            style={{
              color: "var(--color-text-heading)",
              fontWeight: "var(--font-weight-semibold)",
            }}
          >
            安全
          </h2>
        </div>
        <div className="p-5">
          <SignOutButton />
        </div>
      </div>
    </div>
  );
}