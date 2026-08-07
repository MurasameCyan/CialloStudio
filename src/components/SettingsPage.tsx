import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RefreshCw } from "lucide-react";
import { AdminTaskQueuePanel } from "@/components/AdminTaskQueuePanel";
import { LogPanel } from "@/components/LogPanel";
import { UserPoolPanel } from "@/components/UserPoolPanel";
import {
  ApiError,
  listModels,
  rememberUpstreamOrigin,
  resolveBrowserApiBase,
  type OpenAIModel,
} from "@/lib/api";
import {
  checkForUpdate,
  resolveBuildInfo,
  type UpdateCheckResult,
} from "@/lib/buildInfo";
import type { CommunityUser } from "@/lib/community/types";
import { log } from "@/lib/logger";
import {
  getMediaBase,
  getMediaUploadToken,
  getQueueStorageMode,
  getSiteBase,
  pingMediaWorker,
  setMediaBase,
  setMediaUploadToken,
  setQueueStorageMode,
  setSiteBase,
  type QueueStorageMode,
} from "@/lib/media/client";
import { getMasterUsername } from "@/lib/runtimeConfig";
import {
  DEFAULT_SETTINGS,
  type StudioSettings,
  normalizeSettings,
  saveSettings,
} from "@/lib/settings";

type AdminSection = "api" | "users" | "tasks";

/**
 * 模型下拉。模型列表要点「测试连接」才有，所以已存的模型 id 即使不在列表里也保留成选项，
 * 否则换台机器打开管理页会把已配好的模型选空。
 * 用主题同步的自定义弹层代替原生 select，复用 .prompt-history-panel 模式。
 */
function ModelSelect({
  id,
  label,
  value,
  options,
  emptyLabel,
  onPick,
}: {
  id: string;
  label: string;
  value: string;
  options: OpenAIModel[];
  emptyLabel: string;
  onPick: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const current = typeof value === "string" ? value.trim() : "";
  const ids = options.map((m) => m.id);
  const list = current && !ids.includes(current) ? [current, ...ids] : ids;

  function updatePanelPosition() {
    const anchor = btnRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const pad = 12;
    const gap = 4;
    const width = rect.width;
    const spaceBelow = window.innerHeight - rect.bottom - gap - pad;
    const spaceAbove = rect.top - gap - pad;
    const preferBelow = spaceBelow >= 200 || spaceBelow >= spaceAbove;
    const maxHeight = Math.min(280, Math.max(120, preferBelow ? spaceBelow : spaceAbove));
    const left = rect.left;
    const top = preferBelow ? rect.bottom + gap : Math.max(pad, rect.top - gap - maxHeight);
    setPanelStyle({ top, left, width, maxHeight });
  }

  useEffect(() => {
    if (open) {
      updatePanelPosition();
      window.addEventListener("resize", updatePanelPosition);
      window.addEventListener("scroll", updatePanelPosition, true);
      return () => {
        window.removeEventListener("resize", updatePanelPosition);
        window.removeEventListener("scroll", updatePanelPosition, true);
      };
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const target = e.target as Node;
      if (btnRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        // 弹层 portal 到 body 末尾，不还焦点的话键盘用户会被丢到页面开头
        btnRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 同理：Tab 顺序跟 DOM 走，不主动聚焦选中项键盘就进不了弹层
  useEffect(() => {
    if (!open || !panelStyle) return;
    const panel = panelRef.current;
    if (!panel) return;
    const target =
      panel.querySelector<HTMLButtonElement>('[aria-selected="true"]') ??
      panel.querySelector<HTMLButtonElement>('[role="option"]');
    target?.focus();
  }, [open, panelStyle]);

  const panel =
    open && panelStyle
      ? createPortal(
          <div
            ref={panelRef}
            className="prompt-history-panel"
            role="listbox"
            aria-label={label}
            style={{
              top: panelStyle.top,
              left: panelStyle.left,
              width: panelStyle.width,
              maxHeight: panelStyle.maxHeight,
            }}
          >
            <div className="prompt-history-list">
              <button
                type="button"
                role="option"
                aria-selected={!current}
                className="prompt-history-item"
                onClick={() => {
                  onPick("");
                  setOpen(false);
                }}
                style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" }}
              >
                <span className="prompt-history-text">{emptyLabel}</span>
              </button>
              {list.map((mid) => (
                <button
                  key={`${id}-${mid}`}
                  type="button"
                  role="option"
                  aria-selected={mid === current}
                  className="prompt-history-item"
                  onClick={() => {
                    onPick(mid);
                    setOpen(false);
                  }}
                  style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" }}
                >
                  <span className="prompt-history-text">{mid}</span>
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <div className="field">
      <div className="label-row">
        <label htmlFor={id}>{label}</label>
      </div>
      <button
        ref={btnRef}
        id={id}
        type="button"
        className="control mono"
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          textAlign: "left",
          cursor: "pointer",
          paddingRight: "2em",
          position: "relative",
        }}
        onClick={() => setOpen((v) => !v)}
      >
        {current || emptyLabel}
        <span
          style={{
            position: "absolute",
            right: "0.75em",
            top: "50%",
            transform: "translateY(-50%)",
            pointerEvents: "none",
          }}
        >
          ▾
        </span>
      </button>
      {panel}
    </div>
  );
}

type Props = {
  settings: StudioSettings;
  onChange: (next: StudioSettings) => void;
  /** 已登录社区用户（App 保证已登录；role=admin 为站长） */
  communityUser?: CommunityUser | null;
  communityLoading?: boolean;
  onNeedLogin?: () => void;
};

export function SettingsPage({
  settings,
  onChange,
  communityUser = null,
  communityLoading = false,
  onNeedLogin,
}: Props) {
  const isStationMaster = communityUser?.role === "admin";
  const [section, setSection] = useState<AdminSection>("api");
  const [draft, setDraft] = useState<StudioSettings>(() => normalizeSettings(settings ?? {}));
  const [models, setModels] = useState<OpenAIModel[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>("");
  const [ok, setOk] = useState<boolean | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [mediaBase, setMediaBaseDraft] = useState("");
  const [siteBase, setSiteBaseDraft] = useState("");
  const [queueStorageMode, setQueueStorageModeDraft] = useState<QueueStorageMode>("site");
  const [mediaToken, setMediaTokenDraft] = useState("");
  const [mediaBusy, setMediaBusy] = useState(false);
  const [mediaMsg, setMediaMsg] = useState("");
  const [mediaOk, setMediaOk] = useState<boolean | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);
  const buildInfo = useMemo(() => resolveBuildInfo(), []);

  useEffect(() => {
    setMediaBaseDraft(getMediaBase());
    setSiteBaseDraft(getSiteBase());
    setQueueStorageModeDraft(getQueueStorageMode());
    setMediaTokenDraft(getMediaUploadToken());
  }, []);

  async function handleCheckUpdate() {
    setUpdateBusy(true);
    setUpdateResult(null);
    try {
      const result = await checkForUpdate();
      setUpdateResult(result);
      if (result.error) {
        log("error", "版本检测失败", result.error);
      } else if (result.hasUpdate) {
        log("ok", "发现新版本", `${result.current} → ${result.latest}`);
      } else {
        log("ok", "已是最新", result.current);
      }
    } finally {
      setUpdateBusy(false);
    }
  }

  useEffect(() => {
    if (!isStationMaster && section !== "api") {
      setSection("api");
    }
  }, [isStationMaster, section]);

  const apiKey = typeof draft.apiKey === "string" ? draft.apiKey : "";
  const baseUrl = typeof draft.baseUrl === "string" ? draft.baseUrl : "";

  /** 视频模型候选：模型列表里 id 带 video 的 */
  const videoModelOptions = useMemo(() => models.filter((m) => /video/i.test(m.id)), [models]);
  /** 图片 / 提示词模型候选：视频模型不该出现在这些槽里 */
  const nonVideoModelOptions = useMemo(() => models.filter((m) => !/video/i.test(m.id)), [models]);

  function update<K extends keyof StudioSettings>(key: K, value: StudioSettings[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function persist(next: StudioSettings) {
    // 钳制逻辑只在 settings.ts 里一份，这里不再重复
    const normalized = normalizeSettings(next);
    saveSettings(normalized);
    rememberUpstreamOrigin(normalized.baseUrl);
    onChange(normalized);
    setDraft(normalized);
    return normalized;
  }

  async function handleTestAndLoadModels() {
    setBusy(true);
    setMessage("");
    setOk(null);
    try {
      const normalized = persist(draft);
      log("info", "设置页：测试连接", {
        baseUrl: normalized.baseUrl,
        requestBase: resolveBrowserApiBase(normalized.baseUrl),
        model: normalized.model,
        keyPrefix: normalized.apiKey.slice(0, 12),
      });
      const list = await listModels({
        baseUrl: normalized.baseUrl,
        apiKey: normalized.apiKey,
      });
      setModels(list);
      // 自动兜底只在图片模型里挑，别把视频模型塞进「文生图模型」槽
      const imageish = list.filter((m) => !/video/i.test(m.id));
      const preferred =
        list.find((m) => m.id === normalized.model)?.id ||
        imageish.find((m) => m.id.includes("imagine") || m.id.includes("image"))?.id ||
        imageish[0]?.id ||
        normalized.model;
      if (preferred !== normalized.model) {
        persist({ ...normalized, model: preferred });
      }
      setOk(true);
      setMessage(`连接成功 · ${list.length} 个模型 · 当前 ${preferred}`);
    } catch (error) {
      setOk(false);
      let text = error instanceof ApiError ? error.message : error instanceof Error ? error.message : "连接失败";
      if (/CORS|Failed to fetch|network|Load failed|NetworkError|proxy|502|503|504/i.test(text)) {
        text = [
          text,
          "",
          "排查：",
          "1) Base URL 填完整上游，如 https://your-gateway/v1（会经同源 /v1 代理，免 CORS）",
          "2) Docker：pull 最新镜像后 recreate；本地 dev 需 npm run dev",
          "3) 确认上游可访问、API Key 正确",
        ].join("\n");
      } else if (/missing_base_url|填写 API Base|缺少上游/i.test(text)) {
        text = `${text}\n\n在设置页「API Base URL」填：https://你的网关/v1 后保存再测`;
      }
      log("error", "设置页：测试连接失败", text);
      setMessage(text);
    } finally {
      setBusy(false);
    }
  }

  function handleSave() {
    if (!baseUrl.trim()) {
      setOk(false);
      setMessage("请填写 API Base URL（完整地址，如 https://your-gateway/v1）");
      return;
    }
    if (!apiKey.trim()) {
      setOk(false);
      setMessage("请填写 API Key");
      return;
    }
    const normalized = persist({ ...draft, baseUrl, apiKey });
    log("ok", "设置已保存", {
      baseUrl: normalized.baseUrl,
      requestBase: resolveBrowserApiBase(normalized.baseUrl),
      model: normalized.model,
      imageEditModel: normalized.imageEditModel || "(off)",
      videoModel: normalized.videoModel || "(off)",
    });
    setOk(true);
    setMessage(`已保存 · 文生图 ${normalized.model}`);
  }

  function handleReset() {
    setDraft({ ...DEFAULT_SETTINGS });
    setModels([]);
    setOk(null);
    setMessage("已恢复默认值（尚未写入本地，需点保存）");
  }

  function handleSaveMedia() {
    setMediaBase(mediaBase.trim());
    setSiteBase(siteBase.trim());
    setQueueStorageMode(queueStorageMode);
    setMediaUploadToken(mediaToken.trim());
    setMediaOk(true);
    const media = getMediaBase();
    const site = getSiteBase();
    const mode = getQueueStorageMode();
    const parts = [
      media ? `Media ${media}` : "Media 空",
      site ? `Site ${site}` : "Site 空",
      `后台队列→${mode === "media" ? "Media(TG)" : "Site 改写"}`,
    ];
    setMediaMsg(`已保存 · ${parts.join(" · ")}`);
    log("ok", "媒体/站点配置已保存", {
      mediaBase: media || "(empty)",
      siteBase: site || "(empty)",
      queueStorageMode: mode,
    });
  }

  async function handleTestMedia() {
    setMediaBase(mediaBase.trim());
    setSiteBase(siteBase.trim());
    setQueueStorageMode(queueStorageMode);
    setMediaUploadToken(mediaToken.trim());
    setMediaBaseDraft(getMediaBase());
    setSiteBaseDraft(getSiteBase());
    setMediaBusy(true);
    setMediaMsg("");
    setMediaOk(null);
    try {
      if (!getMediaBase()) {
        setMediaOk(false);
        setMediaMsg("请先填写 Media Base（TG Worker 根域名）");
        return;
      }
      const res = await pingMediaWorker();
      setMediaOk(res.ok);
      setMediaMsg(res.ok ? `媒体正常 · ${res.detail}` : `媒体异常 · ${res.detail}`);
      log(res.ok ? "ok" : "error", "媒体 Worker 探测", res.detail);
    } finally {
      setMediaBusy(false);
    }
  }

  const updateStatusText = (() => {
    if (updateBusy) return "检查中…";
    if (!updateResult) return "";
    if (updateResult.error) return updateResult.error;
    if (updateResult.hasUpdate) {
      return `有更新 · ${updateResult.latest}${
        updateResult.publishedAt
          ? ` · ${new Date(updateResult.publishedAt).toLocaleDateString()}`
          : ""
      }`;
    }
    return `已是最新 · ${updateResult.latest || updateResult.current}`;
  })();

  return (
    <div className="page admin-layout">
      <section className="panel admin-hero">
        <div className="admin-hero-top admin-hero-top-row">
          <div>
            <div className="panel-kicker">{isStationMaster ? "Admin" : "Settings"}</div>
            <h2 className="panel-title">{isStationMaster ? "控制台" : "设置"}</h2>
            <p className="panel-desc" style={{ marginTop: 6 }}>
              {isStationMaster ? (
                <>站长 @{communityUser?.username ?? getMasterUsername()} · 接口 / 用户池 / 后台任务 / 媒体</>
              ) : (
                <>@{communityUser?.username ?? "用户"} · 接口与生成</>
              )}
            </p>
          </div>

          <div className="build-version-row" aria-label="版本信息">
            <a
              className="build-version-hash mono-tight"
              href={buildInfo.commitUrl}
              target="_blank"
              rel="noreferrer"
              title={buildInfo.full || buildInfo.hash}
            >
              {buildInfo.hash}
            </a>
            {updateResult?.hasUpdate && updateResult.latest ? (
              <a
                className="build-version-ref"
                href={updateResult.htmlUrl}
                target="_blank"
                rel="noreferrer"
                title={`最新 ${updateResult.latest}`}
              >
                → {updateResult.latest}
              </a>
            ) : null}
            <button
              type="button"
              className={`build-version-icon${
                updateResult?.error
                  ? " build-version-icon-err"
                  : updateResult?.hasUpdate
                    ? " build-version-icon-new"
                    : ""
              }`}
              disabled={updateBusy}
              onClick={() => void handleCheckUpdate()}
              aria-label="检查更新"
              title={updateStatusText || "检查更新 · 对照 GitHub 跟踪分支 HEAD"}
            >
              <RefreshCw
                size={16}
                strokeWidth={2.2}
                className={updateBusy ? "build-version-spin" : undefined}
              />
            </button>
            <a
              className="build-version-icon"
              href={buildInfo.repoUrl}
              target="_blank"
              rel="noreferrer"
              aria-label="GitHub 仓库"
              title={`GitHub · ${buildInfo.githubRepo}`}
            >
              {/* lucide 1.x 已移除品牌图标，octocat 用内联 SVG */}
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
                <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
              </svg>
            </a>
          </div>
        </div>

        {isStationMaster ? (
          <div className="admin-section-switch" role="tablist" aria-label="管理分区">
            <button
              type="button"
              role="tab"
              aria-selected={section === "api"}
              className={`admin-section-switch-btn ${section === "api" ? "active" : ""}`}
              onClick={() => setSection("api")}
            >
              接口设置
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={section === "users"}
              className={`admin-section-switch-btn ${section === "users" ? "active" : ""}`}
              onClick={() => setSection("users")}
            >
              用户池
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={section === "tasks"}
              className={`admin-section-switch-btn ${section === "tasks" ? "active" : ""}`}
              onClick={() => setSection("tasks")}
            >
              后台任务
            </button>
          </div>
        ) : null}

        {isStationMaster && section === "users" ? (
          <p className="panel-desc admin-users-hint">
            管理社区账号池。站长账号由部署 <code>.env</code> 配置（
            <code>CIALLO_MASTER_USERNAME</code> / <code>CIALLO_MASTER_PASSWORD</code>）。
          </p>
        ) : isStationMaster && section === "tasks" ? (
          <p className="panel-desc admin-users-hint">
            管理全站服务端后台队列：查看进度、取消进行中、清理历史记录。
          </p>
        ) : null}
      </section>

      {isStationMaster && section === "users" ? (
        <UserPoolPanel
          communityUser={communityUser}
          communityLoading={communityLoading}
          onNeedLogin={onNeedLogin}
        />
      ) : isStationMaster && section === "tasks" ? (
        <AdminTaskQueuePanel
          communityUser={communityUser}
          communityLoading={communityLoading}
          onNeedLogin={onNeedLogin}
        />
      ) : (
        <>
          <section className="panel admin-form-panel">
            <div className="admin-section admin-section-merged">
              <div className="admin-section-head">
                <div>
                  <div className="section-card-title">Settings</div>
                  <h3 className="admin-section-title">接口与生成</h3>
                </div>
              </div>

              <div className="admin-stack">
                {/* 左：接口（上游 + 动作） · 右：四个模型槽 */}
                <div className="admin-dual-cols">
                  <div className="admin-dual-col">
                    <div className="admin-block-label">接口</div>

                    <div className="field">
                      <div className="label-row">
                        <label htmlFor="baseUrl">API Base URL</label>
                      </div>
                      <input
                        id="baseUrl"
                        className="control mono"
                        value={baseUrl}
                        placeholder="https://your-gateway/v1"
                        onChange={(e) => update("baseUrl", e.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>
                    <div className="field">
                      <div className="label-row">
                        <label htmlFor="apiKey">API Key</label>
                        <button type="button" className="text-link" onClick={() => setShowKey((v) => !v)}>
                          {showKey ? "隐藏" : "显示"}
                        </button>
                      </div>
                      <input
                        id="apiKey"
                        className="control mono"
                        type={showKey ? "text" : "password"}
                        value={apiKey}
                        placeholder="g2a_..."
                        onChange={(e) => update("apiKey", e.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>

                    <div className="admin-actions admin-actions-inline">
                      <div className="btn-row">
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={busy}
                          onClick={handleTestAndLoadModels}
                        >
                          {busy ? "测试中…" : "测试连接"}
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={busy}
                          onClick={handleSave}
                        >
                          保存设置
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger"
                          disabled={busy}
                          onClick={handleReset}
                        >
                          恢复默认
                        </button>
                      </div>
                      {message ? (
                        <div className={`status ${ok === true ? "ok" : ok === false ? "err" : ""}`}>
                          {message}
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div className="admin-dual-col">
                    <div className="admin-block-label">模型</div>

                    <ModelSelect
                      id="model-text2img"
                      label="文生图模型"
                      value={draft.model}
                      options={nonVideoModelOptions}
                      emptyLabel={models.length ? "未选择" : "点「测试连接」加载列表"}
                      onPick={(next) => update("model", next || DEFAULT_SETTINGS.model)}
                    />
                    <ModelSelect
                      id="model-img2img"
                      label="图生图模型"
                      value={draft.imageEditModel}
                      options={nonVideoModelOptions}
                      emptyLabel="不启用"
                      onPick={(next) => update("imageEditModel", next)}
                    />
                    <ModelSelect
                      id="model-video"
                      label="视频模型"
                      value={draft.videoModel}
                      options={videoModelOptions}
                      emptyLabel="不启用"
                      onPick={(next) => update("videoModel", next)}
                    />
                    <ModelSelect
                      id="model-optimize"
                      label="提示词模型"
                      value={draft.promptOptimizeModel}
                      options={nonVideoModelOptions}
                      emptyLabel="不启用"
                      onPick={(next) => update("promptOptimizeModel", next)}
                    />

                  </div>
                </div>
              </div>
            </div>
          </section>

          {isStationMaster ? (
            <section className="panel admin-form-panel">
              <div className="admin-section admin-section-merged">
                <div className="admin-section-head">
                  <div>
                    <div className="section-card-title">Media</div>
                    <h3 className="admin-section-title">存储设置</h3>
                  </div>
                </div>
                <div className="admin-stack">
                  <p className="footer-note">
                    两个 Base 都<strong>只填根域名</strong>（不要带 <code>/v1</code> 路径）。
                    Media = CF Worker → Telegram 公网图链；Site = 上游图片站公网域名，用来改写{" "}
                    <code>127.0.0.1</code> 内网媒体地址。
                  </p>
                  <div className="admin-fields-2">
                    <div className="field">
                      <div className="label-row">
                        <label htmlFor="mediaBase">Media Base URL</label>
                      </div>
                      <input
                        id="mediaBase"
                        className="control mono"
                        value={mediaBase}
                        placeholder="https://img.example.com"
                        onChange={(e) => setMediaBaseDraft(e.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <p className="footer-note">
                        TG Worker / Pages 根域名。大厅分享、以及后台队列选「Media」时上传到此。
                      </p>
                    </div>
                    <div className="field">
                      <div className="label-row">
                        <label htmlFor="mediaToken">Upload Token（可选）</label>
                      </div>
                      <input
                        id="mediaToken"
                        className="control mono"
                        value={mediaToken}
                        placeholder="与 Worker UPLOAD_TOKEN 相同"
                        onChange={(e) => setMediaTokenDraft(e.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <p className="footer-note">仅上传需要；浏览公开图链可不填。</p>
                    </div>
                  </div>
                  <div className="admin-fields-2">
                    <div className="field">
                      <div className="label-row">
                        <label htmlFor="siteBase">Site Base URL</label>
                      </div>
                      <input
                        id="siteBase"
                        className="control mono"
                        value={siteBase}
                        placeholder="https://img.example.com"
                        onChange={(e) => setSiteBaseDraft(e.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <p className="footer-note">
                        上游图片站公网根域名。后台队列选「Site」时，把{" "}
                        <code>http://127.0.0.1:8000/v1/media/...</code> 改写成{" "}
                        <code>https://你的域名/v1/media/...</code>，不经过 TG。
                      </p>
                    </div>
                    <div className="field">
                      <div className="label-row">
                        <label>后台队列储存位置</label>
                      </div>
                      <div className="segmented" role="group" aria-label="后台队列储存位置">
                        <button
                          type="button"
                          className={`chip ${queueStorageMode === "site" ? "active" : ""}`}
                          onClick={() => setQueueStorageModeDraft("site")}
                          title="改写上游媒体 URL 到 Site Base，不上传 TG"
                        >
                          Site Base
                        </button>
                        <button
                          type="button"
                          className={`chip ${queueStorageMode === "media" ? "active" : ""}`}
                          onClick={() => setQueueStorageModeDraft("media")}
                          title="下载上游图后上传 Media Worker（Telegram）"
                        >
                          Media Base
                        </button>
                      </div>
                      <p className="footer-note">
                        {queueStorageMode === "media"
                          ? "Media：出图后上传 TG，图墙用 Worker 公网链（需配置 Media Base）。"
                          : "Site：只改写链接到 Site Base，速度快；上游图站需公网可访问。"}
                      </p>
                    </div>
                  </div>
                  <div className="admin-actions admin-actions-inline">
                    <div className="btn-row">
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={mediaBusy}
                        onClick={() => void handleTestMedia()}
                      >
                        {mediaBusy ? "探测中…" : "测试 Worker"}
                      </button>
                      <button type="button" className="btn btn-secondary" disabled={mediaBusy} onClick={handleSaveMedia}>
                        保存媒体配置
                      </button>
                    </div>
                    {mediaMsg ? (
                      <div className={`status ${mediaOk === true ? "ok" : mediaOk === false ? "err" : ""}`}>
                        {mediaMsg}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </section>
          ) : null}

          {isStationMaster ? <LogPanel /> : null}
        </>
      )}
    </div>
  );
}
