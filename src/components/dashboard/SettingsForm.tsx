"use client";

import { useState } from "react";
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
          <div>
            <label
              className="text-xs font-medium block mb-2"
              style={{ color: "var(--color-text-body)" }}
            >
              <Key style={{ width: 12, height: 12, display: "inline", marginRight: 4 }} />
              GitHub Token
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