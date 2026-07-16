import { useEffect, useState } from "react";
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

  // 队列挂在 App 层：切页也不会丢任务/结果
  const queue = useStudioQueue(settings);
  const ready = Boolean((typeof settings.apiKey === "string" ? settings.apiKey : "").trim());
  const isLoggedIn = Boolean(community.user);
  const isStationMaster = community.user?.role === "admin";

  function openHallAuth() {
    setTab("hall");
  }

  function openSettings() {
    if (community.loading) {
      setTab("settings");
      return;
    }
    if (!isLoggedIn) {
      log("warn", "配置页需先登录，请先在大厅登录");
      setTab("hall");
      return;
    }
    setTab("settings");
  }

  // 已在配置页时若退出登录，立即踢回大厅
  useEffect(() => {
    if (community.loading) return;
    if (tab === "settings" && !isLoggedIn) {
      setTab("hall");
    }
  }, [tab, isLoggedIn, community.loading]);

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
              ? "生成中"
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
              title={
                isStationMaster
                  ? "站长控制台"
                  : isLoggedIn
                    ? "接口与生成设置"
                    : "登录后可配置接口"
              }
            >
              {isStationMaster ? "管理" : isLoggedIn ? "设置" : "管理 🔒"}
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
            isLoggedIn={isLoggedIn}
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
        ) : community.loading ? (
          <div className="page">
            <section className="panel">
              <div className="empty empty-compact">
                <span className="empty-title">校验登录…</span>
              </div>
            </section>
          </div>
        ) : isLoggedIn ? (
          <ErrorBoundary label={isStationMaster ? "管理页" : "设置页"}>
            <SettingsPage
              settings={settings}
              onChange={setSettings}
              communityUser={community.user}
              communityLoading={community.loading}
              onNeedLogin={openHallAuth}
            />
          </ErrorBoundary>
        ) : (
          <div className="page admin-layout">
            <section className="panel admin-hero">
              <div className="panel-kicker">Settings</div>
              <h2 className="panel-title">需要登录</h2>
              <p className="panel-desc">
                配置接口与生成参数前请先到「大厅」登录。登录后普通用户可配置接口；站长还可管理用户池与媒体。
              </p>
              <div className="btn-row" style={{ marginTop: 14 }}>
                <button type="button" className="btn btn-primary" onClick={openHallAuth}>
                  去大厅登录
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => setTab("studio")}>
                  返回生图
                </button>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
