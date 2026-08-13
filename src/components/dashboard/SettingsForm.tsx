"use client";

import { useState } from "react";
import { User, Save, Check, AlertCircle, Loader2, Key, Trash2 } from "lucide-react";
import { SignOutButton } from "@/components/dashboard/SignOutButton";
import { clearLegacyGithubToken, updateUserSettings } from "@/server/settings.actions";

interface Settings {
  name: string;
  githubTokenConfigured?: boolean;
}

interface SettingsFormProps {
  initialSettings: Settings;
}

export function SettingsForm({ initialSettings }: SettingsFormProps) {
  const [settings, setSettings] = useState<Settings>(initialSettings);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");
  const [saveMessage, setSaveMessage] = useState("");

  const handleClearLegacyToken = async () => {
    if (!confirm("确认删除当前账号遗留的个人 GitHub Token？删除后无法恢复。")) return;

    setSaving(true);
    setSaveStatus("idle");
    setSaveMessage("");
    try {
      await clearLegacyGithubToken();
      setSettings((prev) => ({ ...prev, githubTokenConfigured: false }));
      setSaveStatus("success");
      setSaveMessage("遗留个人 GitHub Token 已删除");
    } catch (err) {
      setSaveStatus("error");
      setSaveMessage(err instanceof Error ? err.message : "删除失败");
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveStatus("idle");
    setSaveMessage("");

    try {
      await updateUserSettings(settings);
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
        <div className="p-5 space-y-4">
          {settings.githubTokenConfigured && (
            <div
              className="flex flex-col gap-3 rounded-lg p-3 sm:flex-row sm:items-center sm:justify-between"
              style={{ background: "#FEF2F2", border: "1px solid #FECACA" }}
            >
              <div>
                <p className="text-sm font-medium" style={{ color: "var(--color-error)" }}>
                  检测到遗留个人 GitHub Token
                </p>
                <p className="mt-1 text-xs" style={{ color: "var(--color-text-muted)" }}>
                  该 Token 已不再用于查询。可在此永久删除；管理员也可先迁移到全站共享池。
                </p>
              </div>
              <button
                type="button"
                onClick={handleClearLegacyToken}
                disabled={saving}
                className="btn-danger flex-shrink-0"
              >
                <Trash2 style={{ width: 14, height: 14 }} />
                删除遗留 Token
              </button>
            </div>
          )}
          <SignOutButton />
        </div>
      </div>
    </div>
  );
}