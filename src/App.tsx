import { useMemo, useState } from "react";
import { SettingsPage } from "@/components/SettingsPage";
import { StudioPage } from "@/components/StudioPage";
import { log } from "@/lib/logger";
import { loadSettings, type StudioSettings } from "@/lib/settings";

type Tab = "studio" | "settings";

export default function App() {
  const [tab, setTab] = useState<Tab>("studio");
  const [settings, setSettings] = useState<StudioSettings>(() => {
    const initial = loadSettings();
    log("info", "Ciallo Studio 已加载", {
      baseUrl: initial.baseUrl,
      model: initial.model,
      hasKey: Boolean(initial.apiKey.trim()),
      page: typeof window !== "undefined" ? window.location.href : "",
    });
    return initial;
  });

  const connectionLabel = useMemo(() => {
    if (!settings.apiKey.trim()) return "未配置 API Key · 先去管理页填写";
    return `${settings.model} · ${settings.baseUrl}`;
  }, [settings]);

  const ready = Boolean(settings.apiKey.trim());

  return (
    <div className="app-shell">
      <header className="glass-bar">
        <div className="brand">
          <div className="brand-mark" aria-hidden />
          <div className="brand-text">
            <div className="brand-title">Ciallo Studio</div>
            <div className="brand-sub">{connectionLabel}</div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <div className="connection-chip" title={ready ? "API Key 已配置" : "尚未配置 API Key"}>
            <span className={`live-dot ${ready ? "" : "off"}`} />
            {ready ? "Ready" : "Setup"}
          </div>
          <nav className="nav-pills" aria-label="主导航">
            <button
              type="button"
              className={`nav-pill ${tab === "studio" ? "active" : ""}`}
              onClick={() => setTab("studio")}
            >
              生图
            </button>
            <button
              type="button"
              className={`nav-pill ${tab === "settings" ? "active" : ""}`}
              onClick={() => setTab("settings")}
            >
              管理
            </button>
          </nav>
        </div>
      </header>

      <main className="app-main">
        {tab === "studio" ? (
          <StudioPage settings={settings} onOpenSettings={() => setTab("settings")} />
        ) : (
          <SettingsPage settings={settings} onChange={setSettings} />
        )}
      </main>
    </div>
  );
}
