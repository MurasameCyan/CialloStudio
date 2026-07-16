import { useState } from "react";
import { AccountPage } from "@/components/AccountPage";
import { AdminUnlock } from "@/components/AdminUnlock";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { HallPage } from "@/components/HallPage";
import { SettingsPage } from "@/components/SettingsPage";
import { StudioPage } from "@/components/StudioPage";
import { useCommunityAuth } from "@/hooks/useCommunityAuth";
import { useStudioQueue } from "@/hooks/useStudioQueue";
import { log } from "@/lib/logger";
import { isAdminGateEnabled, isAdminUnlocked, lockAdmin } from "@/lib/runtimeConfig";
import { loadSettings, type StudioSettings } from "@/lib/settings";

type Tab = "studio" | "hall" | "account" | "settings";

export default function App() {
  const [tab, setTab] = useState<Tab>("studio");
  const [settings, setSettings] = useState<StudioSettings>(() => {
    const initial = loadSettings();
    const key = typeof initial.apiKey === "string" ? initial.apiKey : "";
    log("info", "Ciallo Studio 已加载", {
      baseUrl: initial.baseUrl,
      model: initial.model,
      hasKey: Boolean(key.trim()),
      adminGate: isAdminGateEnabled(),
      page: typeof window !== "undefined" ? window.location.href : "",
    });
    return initial;
  });
  const [adminUnlocked, setAdminUnlocked] = useState(() => isAdminUnlocked());
  const community = useCommunityAuth();

  // 队列挂在 App 层：切到管理页也不会丢任务/结果，生成可继续跑
  const queue = useStudioQueue(settings);
  const ready = Boolean((typeof settings.apiKey === "string" ? settings.apiKey : "").trim());
  const gateOn = isAdminGateEnabled();

  function openSettings() {
    if (gateOn && !isAdminUnlocked()) {
      setAdminUnlocked(false);
      setTab("settings");
      return;
    }
    setAdminUnlocked(true);
    setTab("settings");
  }

  function handleUnlocked() {
    setAdminUnlocked(true);
    setTab("settings");
    log("ok", "管理页已解锁（会话内有效）");
  }

  function handleLockAdmin() {
    lockAdmin();
    setAdminUnlocked(false);
    setTab("studio");
    log("info", "已锁定管理页");
  }

  const showUnlock = tab === "settings" && gateOn && !adminUnlocked;

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
              className={`nav-pill ${tab === "account" ? "active" : ""}`}
              onClick={() => setTab("account")}
            >
              用户
            </button>
            <button
              type="button"
              className={`nav-pill ${tab === "settings" || showUnlock ? "active" : ""}`}
              onClick={openSettings}
            >
              管理{gateOn && !adminUnlocked ? " 🔒" : ""}
            </button>
          </nav>
        </div>
      </header>

      <main className="app-main">
        {tab === "studio" ? (
          <StudioPage
            settings={settings}
            onOpenSettings={openSettings}
            onNeedLogin={() => setTab("account")}
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
          <HallPage user={community.user} onNeedLogin={() => setTab("account")} />
        ) : tab === "account" ? (
          <AccountPage
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
        ) : showUnlock ? (
          <ErrorBoundary label="管理解锁">
            <AdminUnlock onUnlocked={handleUnlocked} onCancel={() => setTab("studio")} />
          </ErrorBoundary>
        ) : (
          <ErrorBoundary label="管理页">
            <SettingsPage
              settings={settings}
              onChange={setSettings}
              adminGateEnabled={gateOn}
              onLockAdmin={gateOn ? handleLockAdmin : undefined}
              communityUser={community.user}
              communityLoading={community.loading}
              onNeedLogin={() => setTab("account")}
            />
          </ErrorBoundary>
        )}
      </main>
    </div>
  );
}
