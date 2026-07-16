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
  // 管理页仅站长（role=admin）；无单独管理密码
  const isStationMaster = community.user?.role === "admin";

  function openHallAuth() {
    setTab("hall");
  }

  function openSettings() {
    if (community.loading) {
      setTab("settings");
      return;
    }
    if (!isStationMaster) {
      log("warn", "管理页仅站长可进，请先在大厅登录站长账号");
      setTab("hall");
      return;
    }
    setTab("settings");
  }

  // 已在管理页时若退出站长身份，立即踢回大厅
  useEffect(() => {
    if (community.loading) return;
    if (tab === "settings" && !isStationMaster) {
      setTab("hall");
    }
  }, [tab, isStationMaster, community.loading]);

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
              title={isStationMaster ? "站长控制台" : "仅站长可进入，请先登录"}
            >
              管理{isStationMaster ? "" : " 🔒"}
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
        ) : community.loading ? (
          <div className="page">
            <section className="panel">
              <div className="empty empty-compact">
                <span className="empty-title">校验站长权限…</span>
              </div>
            </section>
          </div>
        ) : isStationMaster ? (
          <ErrorBoundary label="管理页">
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
              <div className="panel-kicker">Admin</div>
              <h2 className="panel-title">需要站长登录</h2>
              <p className="panel-desc">
                管理页（接口设置 / 用户池 / 媒体）仅站长可访问。请到「大厅」使用站长账号登录
                {isMasterConfigured() ? (
                  <>
                    （用户名 <code>{getMasterUsername()}</code>，密码见部署 .env）。
                  </>
                ) : (
                  <>
                    （本地 Mock：<code>admin / admin123</code>）。
                  </>
                )}
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
