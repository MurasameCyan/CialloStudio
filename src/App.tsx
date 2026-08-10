import { useEffect, useState } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { HallPage } from "@/components/HallPage";
import { SettingsPage } from "@/components/SettingsPage";
import { StudioModeSwitch } from "@/components/StudioModeSwitch";
import { StudioPage } from "@/components/StudioPage";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useCommunityAuth } from "@/hooks/useCommunityAuth";
import { useStudioQueue } from "@/hooks/useStudioQueue";
import { communityApi } from "@/lib/community/client";
import {
  canUseBackgroundTasks,
  DEFAULT_QUEUE_POLICY,
  type MyQueuePolicy,
} from "@/lib/community/types";
import { log } from "@/lib/logger";
import { getMasterUsername, isMasterConfigured } from "@/lib/runtimeConfig";
import { loadSettings, type StudioSettings } from "@/lib/settings";
import { loadStudioMode, saveStudioMode, type StudioMode } from "@/lib/studioMode";
import { applyTheme, loadTheme, saveTheme, type UiTheme } from "@/lib/theme";

type Tab = "studio" | "hall" | "settings";

export default function App() {
  const [tab, setTab] = useState<Tab>("studio");
  const [theme, setTheme] = useState<UiTheme>(() => loadTheme());
  const [studioMode, setStudioMode] = useState<StudioMode>(() => loadStudioMode());
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
  const [queuePolicy, setQueuePolicy] = useState<MyQueuePolicy | null>(null);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // 登录后拉取本人队列策略（含普通用户后台开关）
  useEffect(() => {
    if (!community.user) {
      setQueuePolicy(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const p = await communityApi.getMyQueuePolicy();
        if (!cancelled) setQueuePolicy(p);
      } catch {
        if (!cancelled) {
          // 兜底：仅按角色（普通用户默认关）
          setQueuePolicy({
            ...DEFAULT_QUEUE_POLICY,
            canBackground: canUseBackgroundTasks(community.user?.role, DEFAULT_QUEUE_POLICY),
            myLimit:
              community.user?.role === "admin"
                ? null
                : community.user?.role === "vip"
                  ? DEFAULT_QUEUE_POLICY.vipLimit
                  : DEFAULT_QUEUE_POLICY.userLimit,
            myConcurrency:
              community.user?.role === "admin"
                ? DEFAULT_QUEUE_POLICY.adminConcurrency
                : community.user?.role === "vip"
                  ? DEFAULT_QUEUE_POLICY.vipConcurrency
                  : DEFAULT_QUEUE_POLICY.userConcurrency,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [community.user]);

  // 鉴权 / 队列策略未就绪时先不收紧 cap，避免把 localStorage 里已选的并发写坏
  const queuePolicyReady = !community.loading && (!community.user || queuePolicy != null);
  const concurrencyCap = !queuePolicyReady
    ? 8
    : typeof queuePolicy?.myConcurrency === "number" && queuePolicy.myConcurrency > 0
      ? queuePolicy.myConcurrency
      : community.user?.role === "admin"
        ? DEFAULT_QUEUE_POLICY.adminConcurrency
        : community.user?.role === "vip"
          ? DEFAULT_QUEUE_POLICY.vipConcurrency
          : DEFAULT_QUEUE_POLICY.userConcurrency;

  // 队列挂在 App 层：切页也不会丢任务/结果
  const queue = useStudioQueue(settings, { concurrencyCap });
  const ready = Boolean((typeof settings.apiKey === "string" ? settings.apiKey : "").trim());
  const isLoggedIn = Boolean(community.user);
  const isStationMaster = community.user?.role === "admin";
  const allowBackgroundTasks =
    queuePolicy?.canBackground === true ||
    canUseBackgroundTasks(community.user?.role, queuePolicy);
  // 服务端后台：serverMode 即表示有服务端任务；浏览器后台仍看 running
  const serverBackground = allowBackgroundTasks && queue.serverMode;
  const localBackground =
    allowBackgroundTasks && queue.draft.backgroundTasks === true && queue.running && !queue.serverMode;
  const backgroundTasksActive = serverBackground || localBackground;

  // 无权限时强制关闭后台任务开关（普通用户 / 登出）
  // 必须等鉴权+策略就绪，否则冷启动会把已持久化的「后台任务」误写成 false
  useEffect(() => {
    if (!queuePolicyReady) return;
    if (!allowBackgroundTasks && queue.draft.backgroundTasks) {
      queue.setDraft({ backgroundTasks: false });
    }
  }, [queuePolicyReady, allowBackgroundTasks, queue.draft.backgroundTasks, queue.setDraft]);

  // 浏览器队列后台：关页会中断。服务端队列可关页续跑，不再强拦。
  useEffect(() => {
    if (!localBackground) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "后台任务仍在浏览器生成，关闭后请求会中断。";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [localBackground]);

  function openHallAuth() {
    setTab("hall");
  }

  function openStudio() {
    setTab("studio");
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
    <div className={`app-shell app-shell-${tab}`}>
      <header className="glass-bar app-header">
        <div className="brand">
          <div className="brand-mark" aria-hidden />
          <div className="brand-text">
            <div className="brand-kicker">Creative engine</div>
            <div className="brand-title">Ciallo Studio</div>
          </div>
        </div>

        <div className="header-right">
          <div className="header-status">
            <div
              className={`connection-chip ${backgroundTasksActive ? "connection-chip-bg" : ""}`}
              title={
                backgroundTasksActive
                  ? `${serverBackground ? "服务端" : "浏览器"}后台任务 · 完成 ${queue.stats.done}/${queue.stats.total} · 失败 ${queue.stats.failed}`
                  : ready
                    ? "API Key 已配置"
                    : "尚未配置 API Key"
              }
            >
              <span className={`live-dot ${ready || backgroundTasksActive ? "" : "off"}`} />
              {backgroundTasksActive
                ? `${serverBackground ? "服" : "后"} ${queue.stats.done + queue.stats.failed}/${queue.stats.total}`
                : queue.running
                  ? "生成中"
                  : community.user
                    ? community.user.displayName
                    : ready
                      ? "Ready"
                      : "Setup"}
            </div>
          </div>
          <div className="header-controls">
            {tab === "studio" ? (
              <StudioModeSwitch
                mode={studioMode}
                onChange={(mode) => {
                  saveStudioMode(mode);
                  setStudioMode(mode);
                }}
              />
            ) : null}
            <ThemeToggle
              theme={theme}
              onChange={(next) => {
                saveTheme(next);
                setTheme(next);
              }}
            />
          </div>
          <nav className="nav-pills" aria-label="主导航">
            <button
              type="button"
              className={`nav-pill ${tab === "studio" ? "active" : ""}`}
              onClick={() => setTab("studio")}
            >
              创作
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
        {backgroundTasksActive && tab !== "studio" ? (
          <div className="bg-task-banner" role="status" aria-live="polite">
            <div className="bg-task-banner-text">
              <strong>{serverBackground ? "服务端队列" : "后台任务"}</strong>
              <span>
                {serverBackground
                  ? `排队/生成中 ${queue.serverQueue.filter((t) => t.status === "queued" || t.status === "running").length}`
                  : `生成中 ${queue.stats.done + queue.stats.failed}/${queue.stats.total}`}
                {queue.stats.failed > 0 ? ` · 失败 ${queue.stats.failed}` : ""}
                {queue.draft.autoRetry ? " · 自动重试开" : ""}
                {serverBackground ? " · 关页可续跑" : " · 关页会中断"}
              </span>
            </div>
            <div className="bg-task-banner-actions">
              <button type="button" className="btn btn-secondary btn-sm" onClick={openStudio}>
                回创作
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={queue.stop}>
                停止
              </button>
            </div>
          </div>
        ) : null}
        {tab === "studio" ? (
          <ErrorBoundary label="创作页">
            <StudioPage
              mode={studioMode}
              settings={settings}
              onOpenSettings={openSettings}
              onNeedLogin={openHallAuth}
              isLoggedIn={isLoggedIn}
              canBackgroundTasks={allowBackgroundTasks}
              concurrencyCap={concurrencyCap}
              draft={queue.draft}
              setDraft={queue.setDraft}
              jobs={queue.jobs}
              running={queue.running}
              enqueueBusy={queue.enqueueBusy}
              queueNotice={queue.queueNotice}
              onClearQueueNotice={queue.clearQueueNotice}
              serverMode={queue.serverMode}
              serverQueue={queue.serverQueue}
              onRefreshServerQueue={() => void queue.refreshServerQueue()}
              onCancelServerQueueItem={(id) => queue.cancelServerQueueItem(id)}
              onClearServerQueue={(mode) => queue.clearServerQueue(mode)}
              prompts={queue.prompts}
              plannedJobs={queue.plannedJobs}
              stats={queue.stats}
              progress={queue.progress}
              onStart={queue.start}
              onStop={queue.stop}
              onClear={queue.clear}
            />
          </ErrorBoundary>
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
                  返回创作
                </button>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
