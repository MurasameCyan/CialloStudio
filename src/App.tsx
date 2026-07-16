import { useMemo, useState } from "react";
import { LogPanel } from "@/components/LogPanel";
import { SettingsPage } from "@/components/SettingsPage";
import { StudioPage } from "@/components/StudioPage";
import { log } from "@/lib/logger";
import { loadSettings, type StudioSettings } from "@/lib/settings";

type Tab = "studio" | "settings";

export default function App() {
  const [tab, setTab] = useState<Tab>("studio");
  const [logOpen, setLogOpen] = useState(true);
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
    if (!settings.apiKey.trim()) return "未配置 API Key";
    return `${settings.model} · ${settings.baseUrl}`;
  }, [settings]);

  return (
    <div className={`app-shell ${logOpen ? "with-log-open" : "with-log-collapsed"}`}>
      <header className="glass-bar">
        <div className="brand">
          <div className="brand-mark" aria-hidden />
          <div className="brand-text">
            <div className="brand-title">Ciallo Studio</div>
            <div className="brand-sub">{connectionLabel}</div>
          </div>
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
          <button
            type="button"
            className={`nav-pill ${logOpen ? "active" : ""}`}
            onClick={() => setLogOpen((v) => !v)}
            title="显示/隐藏运行日志"
          >
            日志
          </button>
        </nav>
      </header>

      <main className="app-main">
        {tab === "studio" ? (
          <StudioPage settings={settings} onOpenSettings={() => setTab("settings")} />
        ) : (
          <SettingsPage settings={settings} onChange={setSettings} />
        )}
      </main>

      <LogPanel open={logOpen} onOpenChange={setLogOpen} />
    </div>
  );
}
