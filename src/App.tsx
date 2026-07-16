import { useState } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { HallPage } from "@/components/HallPage";
import { SettingsPage } from "@/components/SettingsPage";
import { StudioPage } from "@/components/StudioPage";
import { useCommunityAuth } from "@/hooks/useCommunityAuth";
import { useStudioQueue } from "@/hooks/useStudioQueue";
import { log } from "@/lib/logger";
import { getMasterUsername, isMasterConfigured } from "@/lib/runtimeConfig";
import { loadSettings, type StudioSettings } from "@/lib/settings";

type Tab = "studio" | "hall" | "settings";

export default function App() {
  const [tab, setTab] = useState<Tab>("studio");
  const [settings, setSettings] = useState<StudioSettings>(() => {
    const initial = loadSettings();
    const key = typeof initial.apiKey === "string" ? initial.apiKey : "";
    log("info", "Ciallo Studio 已加载", {
      baseUrl: initial.baseUrl,
      model: initial.model,
      hasKey: Boolean(key.trim()),
      master: isMasterConfigured() ? getMasterUsername() : "(mock admin)",
      page: typeof window !== "undefined" ? window.location.href : "",
    });
    return initial;
  });
  const community = useCommunityAuth();

  // 队列挂在 App 层：切到管理页也不会丢任务/结果，生成可继续跑
  const queue = useStudioQueue(settings);
  const ready = Boolean((typeof settings.apiKey === "string" ? settings.apiKey : "").trim());
  // 管理权限 = 社区站长（admin 角色），无单独管理密码
  const isStationMaster = community.user?.role === "admin";

  function openSettings() {
    setTab("settings");
  }

  function openHallAuth() {
    setTab("hall");
  }

  return (
    <div className="app-shell">
      <header className="glass-bar">
        <div className="brand">
          <div className="brand-mark" aria-hidden />
          <div className="brand-text">
            <div className="brand-title">Ciallo Studio</div>
          </div>
        </div>

        <div className="header-right">
          <div className="connection-chip" title={ready ? "API Key 已配置" : "尚未配置 API Key"}>
            <span className={`live-dot ${ready ? "" : "off"}`} />
            {queue.running
              ? `在飞 ${queue.inFlight}/${Math.max(1, Math.min(queue.draft.concurrency, queue.stats.total || queue.plannedJobs || 1))}`
              : community.user
                ? community.user.displayName
                : ready
                  ? "Ready"
                  : "Setup"}
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
              className={`nav-pill ${tab === "hall" ? "active" : ""}`}
              onClick={() => setTab("hall")}
            >
              大厅
            </button>
            <button
              type="button"
              className={`nav-pill ${tab === "settings" ? "active" : ""}`}
              onClick={openSettings}
            >
              管理
            </button>
          </nav>
        </div>
      </header>

      <main className="app-main">
        {tab === "studio" ? (
          <StudioPage
            settings={settings}
            onOpenSettings={openSettings}
            onNeedLogin={openHallAuth}
            onSharedToHall={() => setTab("hall")}
            draft={queue.draft}
            setDraft={queue.setDraft}
            jobs={queue.jobs}
            running={queue.running}
            inFlight={queue.inFlight}
            prompts={queue.prompts}
            plannedJobs={queue.plannedJobs}
            stats={queue.stats}
            progress={queue.progress}
            onStart={queue.start}
            onStop={queue.stop}
            onClear={queue.clear}
          />
        ) : tab === "hall" ? (
          <HallPage
            user={community.user}
            loading={community.loading}
            onLogin={async (username, password) => {
              await community.login({ username, password });
            }}
            onRegister={async (username, password, displayName) => {
              await community.register({ username, password, displayName });
            }}
            onLogout={async () => {
              await community.logout();
            }}
          />
        ) : (
          <ErrorBoundary label="管理页">
            <SettingsPage
              settings={settings}
              onChange={setSettings}
              isStationMaster={isStationMaster}
              communityUser={community.user}
              communityLoading={community.loading}
              onNeedLogin={openHallAuth}
            />
          </ErrorBoundary>
        )}
      </main>
    </div>
  );
}
