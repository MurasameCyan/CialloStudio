import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { ShareCooldownBanner, isShareCooling } from "@/components/ShareCooldownBanner";
import { ApiError, optimizePromptText } from "@/lib/api";
import { communityApi } from "@/lib/community/client";
import {
  computeShareRemainSec,
  type ShareStatus,
} from "@/lib/community/types";
import { downloadJobs } from "@/lib/download";
import { getImageModelCapability } from "@/lib/imageModels";
import { log } from "@/lib/logger";
import { isMediaConfigured, uploadMedia } from "@/lib/media/client";
import {
  ASPECT_RATIOS,
  RESOLUTIONS,
  resolvePromptOptimizeEndpoint,
  type StudioSettings,
} from "@/lib/settings";
import {
  CONCURRENCY_OPTIONS,
  VARIANT_OPTIONS,
  displayUrl,
  type StudioDraft,
  type StudioJob,
} from "@/lib/studioQueue";
import type { StudioMode } from "@/lib/studioMode";

const StudioJobCard = memo(function StudioJobCard({
  job,
  selected,
  downloading,
  sharingId,
  shareLocked,
  alreadyShared,
  onToggle,
  onPreview,
  onShare,
}: {
  job: StudioJob;
  selected: boolean;
  downloading: boolean;
  sharingId: string | null;
  shareLocked: boolean;
  alreadyShared: boolean;
  onToggle: (id: string) => void;
  onPreview: (job: StudioJob) => void;
  onShare: (job: StudioJob) => void;
}) {
  const src = displayUrl(job);
  const canSelect = job.status === "done" && Boolean(src || job.openUrl);
  const shareBusy = sharingId === job.id;
  const shareDisabled = alreadyShared || shareBusy || shareLocked;
  const shareLabel = alreadyShared
    ? "已分享"
    : shareBusy
      ? "分享中…"
      : shareLocked
        ? "冷却中"
        : "分享到大厅";
  const shareTitle = alreadyShared
    ? "该图已分享，不可重复分享"
    : shareLocked
      ? "分享冷却中"
      : "分享到大厅";
  return (
    <article className={`card ${selected ? "selected" : ""}`}>
      <span
        className={`badge ${
          job.status === "done" ? "done" : job.status === "failed" ? "failed" : "running"
        }`}
      >
        #{job.variant}/{job.variants}
      </span>
      {canSelect ? (
        <label className="card-check" title="勾选下载">
          <input
            type="checkbox"
            checked={selected}
            disabled={downloading}
            onChange={() => onToggle(job.id)}
          />
        </label>
      ) : null}
      <div
        className="card-media"
        onClick={() => {
          if (canSelect) onToggle(job.id);
        }}
      >
        {job.status === "done" && src ? (
          <>
            <img
              src={src}
              alt={`${job.prompt} #${job.variant}`}
              loading="lazy"
              decoding="async"
            />
            <div className="card-overlay">
              <a
                href={job.openUrl || src}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                打开原图
              </a>
              <button
                type="button"
                className="card-overlay-action"
                title="页内大图预览"
                onClick={(e) => {
                  e.stopPropagation();
                  onPreview(job);
                }}
              >
                显示大图
              </button>
              <button
                type="button"
                className={`btn btn-sm ${alreadyShared ? "btn-shared" : "btn-primary"}`}
                disabled={shareDisabled}
                title={shareTitle}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!alreadyShared) onShare(job);
                }}
              >
                {shareLabel}
              </button>
            </div>
          </>
        ) : job.status === "failed" ? (
          <div
            className="skeleton"
            style={{ animation: "none", display: "grid", placeItems: "center", padding: 16 }}
          >
            <span style={{ color: "var(--danger)", fontSize: 13, textAlign: "center" }}>{job.error}</span>
          </div>
        ) : (
          <div className="skeleton" />
        )}
      </div>
      <div className="card-body">
        <div className="card-meta">
          <strong>#{job.variant}</strong>
          {job.prompt}
          {job.resolution ? ` · ${job.resolution}` : ""}
        </div>
      </div>
    </article>
  );
});

type Stats = { total: number; done: number; failed: number; active: number; running: number; queued: number };

type Props = {
  mode?: StudioMode;
  settings: StudioSettings;
  onOpenSettings: () => void;
  /** 未登录时跳转账号页 */
  onNeedLogin?: () => void;
  /** 是否已登录社区账号（未配置 Key 时决定去登录还是去设置） */
  isLoggedIn?: boolean;
  draft: StudioDraft;
  setDraft: (patch: Partial<StudioDraft>) => void;
  jobs: StudioJob[];
  running: boolean;
  prompts: string[];
  plannedJobs: number;
  stats: Stats;
  progress: number;
  onStart: () => Promise<void>;
  onStop: () => void;
  onClear: () => void;
};

export function StudioPage({
  mode = "console",
  settings,
  onOpenSettings,
  onNeedLogin,
  isLoggedIn = false,
  draft,
  setDraft,
  jobs,
  running,
  prompts,
  plannedJobs,
  stats,
  progress,
  onStart,
  onStop,
  onClear,
}: Props) {
  const configured = Boolean((typeof settings.apiKey === "string" ? settings.apiKey : "").trim());
  const modelCap = useMemo(() => getImageModelCapability(settings.model), [settings.model]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [downloading, setDownloading] = useState(false);
  const [sharingId, setSharingId] = useState<string | null>(null);
  /** 本会话已成功分享过的 job id，禁止重复点分享 */
  const [sharedJobIds, setSharedJobIds] = useState<Set<string>>(() => new Set());
  const [previewJob, setPreviewJob] = useState<StudioJob | null>(null);
  const [shareStatus, setShareStatus] = useState<ShareStatus | null>(null);
  /** 仅在用户点过「分享到大厅」后展示冷却/结果条，默认不占位 */
  const [shareUiRevealed, setShareUiRevealed] = useState(false);
  const [shareNotice, setShareNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [optimizeBusy, setOptimizeBusy] = useState(false);
  /** 优化前快照，供「回退」一次 */
  const [promptBeforeOptimize, setPromptBeforeOptimize] = useState<string | null>(null);
  const [optimizeNotice, setOptimizeNotice] = useState<{ ok: boolean; text: string } | null>(null);
  /** 图片墙：仅展示 status=done 的卡片 */
  const [successOnly, setSuccessOnly] = useState(() => {
    try {
      return localStorage.getItem("ciallo.gallery.successOnly") === "1";
    } catch {
      return false;
    }
  });

  const optimizeEndpoint = useMemo(() => resolvePromptOptimizeEndpoint(settings), [settings]);
  const canOptimize = Boolean(
    optimizeEndpoint.model &&
      optimizeEndpoint.baseUrl &&
      optimizeEndpoint.apiKey &&
      draft.promptText.trim() &&
      !optimizeBusy &&
      !running,
  );

  const shareCooldownLocked = isShareCooling(shareStatus);

  useEffect(() => {
    if (!isLoggedIn) {
      setShareStatus(null);
      setShareUiRevealed(false);
      setShareNotice(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const st = await communityApi.getShareStatus();
        if (!cancelled) setShareStatus(st);
      } catch {
        if (!cancelled) setShareStatus(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isLoggedIn]);

  useEffect(() => {
    if (!shareNotice) return;
    // 冷却中的提示由独立 banner 展示，这里不自动关掉冷却文案
    if (!shareNotice.ok && /冷却/.test(shareNotice.text)) return;
    const id = window.setTimeout(() => setShareNotice(null), shareNotice.ok ? 2800 : 6000);
    return () => window.clearTimeout(id);
  }, [shareNotice]);

  const [, setShareClock] = useState(0);
  const handleShareCooldownExpired = useCallback(() => {
    setShareUiRevealed(false);
    setShareNotice((prev) => (prev && !prev.ok && /冷却/.test(prev.text) ? null : prev));
    // one re-render so share buttons unlock without a 1Hz parent timer
    setShareClock((n) => n + 1);
  }, []);

  const handlePreviewJob = useCallback((job: StudioJob) => {
    setPreviewJob(job);
  }, []);

  const closePreview = useCallback(() => {
    setPreviewJob(null);
  }, []);

  useEffect(() => {
    if (!previewJob) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setPreviewJob(null);
    }
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [previewJob]);

  const safeJobs = Array.isArray(jobs) ? jobs : [];
  const wallJobs = useMemo(
    () => (successOnly ? safeJobs.filter((job) => job && job.status === "done") : safeJobs),
    [safeJobs, successOnly],
  );
  const downloadableJobs = useMemo(
    () =>
      safeJobs.filter(
        (job) => job && job.status === "done" && Boolean(displayUrl(job) || job.openUrl),
      ),
    [safeJobs],
  );

  function toggleSuccessOnly() {
    setSuccessOnly((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("ciallo.gallery.successOnly", next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }
  const downloadableIds = useMemo(() => new Set(downloadableJobs.map((j) => j.id)), [downloadableJobs]);

  // 清理已不存在或不可下载的勾选
  useEffect(() => {
    setSelected((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (downloadableIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed || next.size !== prev.size ? next : prev;
    });
  }, [downloadableIds]);

  const selectedCount = selected.size;
  const allSelected = downloadableJobs.length > 0 && selectedCount === downloadableJobs.length;

  function selectAll() {
    setSelected(new Set(downloadableJobs.map((j) => j.id)));
  }

  function clearSelection() {
    setSelected(new Set());
  }

  function toggleSelectAll() {
    if (allSelected) clearSelection();
    else selectAll();
  }

  async function handleDownloadSelected() {
    const targets = downloadableJobs.filter((j) => selected.has(j.id));
    if (targets.length === 0 || downloading) return;
    setDownloading(true);
    log("info", `开始下载 ${targets.length} 张已选图片`);
    try {
      const result = await downloadJobs(targets, { apiKey: settings.apiKey });
      log("ok", `下载完成：成功 ${result.ok} · 失败 ${result.failed}`);
    } catch (error) {
      log("error", "批量下载失败", error instanceof Error ? error.message : String(error));
    } finally {
      setDownloading(false);
    }
  }

  function openConfigOrLogin() {
    if (!isLoggedIn) {
      onNeedLogin?.();
      return;
    }
    onOpenSettings();
  }

  async function handleGenerate() {
    if (!configured) {
      openConfigOrLogin();
      return;
    }
    try {
      await onStart();
    } catch (error) {
      const message = error instanceof ApiError ? error.message : error instanceof Error ? error.message : "启动失败";
      log("error", "启动生成失败", message);
    }
  }

  async function handleOptimizePrompt() {
    const ep = resolvePromptOptimizeEndpoint(settings);
    if (!ep.model) {
      setOptimizeNotice({ ok: false, text: "请先在设置页填写「提示词优化模型」" });
      openConfigOrLogin();
      return;
    }
    if (!ep.baseUrl || !ep.apiKey) {
      setOptimizeNotice({
        ok: false,
        text: ep.usingCustomUpstream
          ? "请填写独立优化 API Base URL 与 Key"
          : "请先配置生图 API Base URL 与 Key",
      });
      openConfigOrLogin();
      return;
    }
    const current = draft.promptText;
    if (!current.trim()) {
      setOptimizeNotice({ ok: false, text: "请先输入提示词" });
      return;
    }
    setOptimizeBusy(true);
    setOptimizeNotice(null);
    try {
      const optimized = await optimizePromptText({
        baseUrl: ep.baseUrl,
        apiKey: ep.apiKey,
        model: ep.model,
        promptText: current,
        mode: draft.promptMode === "block" ? "block" : "lines",
      });
      setPromptBeforeOptimize(current);
      setDraft({ promptText: optimized });
      setOptimizeNotice({ ok: true, text: "已优化并覆盖输入框 · 可点「回退」恢复" });
      log("ok", "提示词优化完成", {
        model: ep.model,
        customUpstream: ep.usingCustomUpstream,
        promptMode: draft.promptMode,
      });
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : "优化失败";
      setOptimizeNotice({ ok: false, text: message });
      log("error", "提示词优化失败", message);
    } finally {
      setOptimizeBusy(false);
    }
  }

  function handleUndoOptimize() {
    if (promptBeforeOptimize == null) return;
    setDraft({ promptText: promptBeforeOptimize });
    setPromptBeforeOptimize(null);
    setOptimizeNotice({ ok: true, text: "已回退到优化前的提示词" });
    log("info", "提示词已回退");
  }

  function handleClearPrompt() {
    if (!draft.promptText) return;
    setDraft({ promptText: "" });
    setPromptBeforeOptimize(null);
    setOptimizeNotice(null);
    log("info", "已清空提示词");
  }

  function handleClear() {
    clearSelection();
    onClear();
  }

  const handleShareToHall = useCallback(async (job: StudioJob) => {
    const src = displayUrl(job) || job.openUrl;
    if (!src || job.status !== "done") return;
    if (sharedJobIds.has(job.id)) {
      setShareNotice({ ok: true, text: "该图已分享" });
      return;
    }
    setShareUiRevealed(true);
    if (isShareCooling(shareStatus)) {
      const remain = shareStatus
        ? computeShareRemainSec(shareStatus.cooldownSec, shareStatus.lastShareAt)
        : 0;
      const text = remain > 0 ? `分享冷却中：还剩 ${remain} 秒` : "分享冷却中";
      setShareNotice({ ok: false, text });
      log("warn", text);
      return;
    }
    setSharingId(job.id);
    setShareNotice(null);
    try {
      const me = await communityApi.me();
      if (!me) {
        log("warn", "分享大厅需要先登录社区账号");
        setShareNotice({ ok: false, text: "请先登录社区账号再分享到大厅" });
        setShareUiRevealed(true);
        onNeedLogin?.();
        return;
      }

      // 配置了 CF Worker 时：先上传到 Telegram 存图，再把稳定 URL 写入大厅
      let imageUrl = src;
      let mediaId: string | undefined;
      if (isMediaConfigured()) {
        log("info", "分享：上传到媒体 Worker（Telegram）…");
        const uploaded = await uploadMedia(src, {
          filename: `ciallo-${job.id.slice(0, 10)}.jpg`,
        });
        imageUrl = uploaded.url;
        mediaId = uploaded.mediaId;
        log("ok", "媒体已入库", { mediaId, url: imageUrl });
      } else {
        log("info", "未配置 Media Base，使用原图 URL 分享（Mock / 临时）");
      }

      await communityApi.createPost({
        imageUrl,
        mediaId,
        prompt: job.prompt,
        model: settings.model,
        aspectRatio: job.aspectRatio || draft.aspectRatio,
        resolution: job.resolution || draft.resolution,
      });
      log("ok", "已分享到大厅");
      setSharedJobIds((prev) => {
        const next = new Set(prev);
        next.add(job.id);
        return next;
      });
      let nextCooldown = shareStatus?.cooldownSec;
      try {
        const st = await communityApi.getShareStatus();
        setShareStatus(st);
        nextCooldown = st.cooldownSec;
      } catch {
        // ignore refresh errors
      }
      // 有冷却：由独立 banner 倒计时；无冷却：短暂成功提示。不再自动跳转大厅。
      if (nextCooldown && nextCooldown > 0) {
        setShareNotice(null);
        setShareUiRevealed(true);
      } else {
        setShareNotice({ ok: true, text: "已分享到大厅" });
        setShareUiRevealed(false);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("error", "分享失败", message);
      setShareUiRevealed(true);
      setShareNotice({ ok: false, text: message });
      // 若是冷却错误，刷新状态以便倒计时同步
      if (/冷却/.test(message)) {
        try {
          const st = await communityApi.getShareStatus();
          setShareStatus(st);
          setShareNotice(null);
          setShareUiRevealed(true);
        } catch {
          // ignore
        }
      }
    } finally {
      setSharingId(null);
    }
  }, [
    draft.aspectRatio,
    draft.resolution,
    onNeedLogin,
    settings.model,
    shareStatus,
    sharedJobIds,
  ]);

  const feedbackBars = (
    <>
      <ShareCooldownBanner
        shareStatus={shareStatus}
        revealed={shareUiRevealed}
        onExpired={handleShareCooldownExpired}
      />
      {!shareUiRevealed || !shareCooldownLocked
        ? shareNotice
          ? (
            <div
              className={`studio-feedback ${shareNotice.ok ? "studio-feedback-ok" : "studio-feedback-warn"}`}
              role="status"
            >
              <span className={`studio-feedback-dot ${shareNotice.ok ? "ok" : "warn"}`} aria-hidden />
              <span className="studio-feedback-text">{shareNotice.text}</span>
            </div>
          )
          : null
        : null}
      {!configured ? (
        <div className="studio-feedback studio-feedback-muted" role="status">
          <span className="studio-feedback-dot muted" aria-hidden />
          <span className="studio-feedback-text">
            {isLoggedIn
              ? "尚未配置 API Key · 请到「设置」填写接口与密钥"
              : "尚未配置 API Key · 请先登录，再到「设置」填写"}
          </span>
        </div>
      ) : null}
    </>
  );

  const promptGroups = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, StudioJob[]>();
    for (const job of wallJobs) {
      const key = job.prompt || "(empty)";
      if (!map.has(key)) {
        map.set(key, []);
        order.push(key);
      }
      map.get(key)!.push(job);
    }
    return order.map((prompt) => ({ prompt, jobs: map.get(prompt)! }));
  }, [wallJobs]);

  const [chatParamsOpen, setChatParamsOpen] = useState(false);

  const handleToggleSelected = useCallback((id: string) => {
    setSelected((prev) => {
      if (!downloadableIds.has(id) && !prev.has(id)) return prev;
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, [downloadableIds]);

  const renderJobCard = (job: StudioJob) => (
    <StudioJobCard
      key={job.id}
      job={job}
      selected={selected.has(job.id)}
      downloading={downloading}
      sharingId={sharingId}
      shareLocked={shareCooldownLocked}
      alreadyShared={sharedJobIds.has(job.id)}
      onToggle={handleToggleSelected}
      onPreview={handlePreviewJob}
      onShare={(j) => {
        void handleShareToHall(j);
      }}
    />
  );

  // Prefer the same display source as the card thumbnail (blob/data first), then openUrl.
  const previewSrc = previewJob
    ? (typeof previewJob.imageUrl === "string" && previewJob.imageUrl
        ? previewJob.imageUrl
        : displayUrl(previewJob) || previewJob.openUrl)
    : undefined;
  const previewOpenHref =
    previewJob?.openUrl ||
    (previewSrc && !previewSrc.startsWith("blob:") ? previewSrc : undefined);
  const previewLightbox = previewJob && previewSrc ? (
    <div
      className="studio-lightbox-backdrop"
      role="presentation"
      onClick={closePreview}
    >
      <div
        className="studio-lightbox"
        role="dialog"
        aria-modal="true"
        aria-label="大图预览"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="studio-lightbox-top">
          <div className="studio-lightbox-meta" title={previewJob.prompt}>
            <strong>#{previewJob.variant}</strong>
            <span>{previewJob.prompt}</span>
          </div>
          <div className="studio-lightbox-actions">
            {previewOpenHref ? (
              <a
                className="btn btn-secondary btn-sm"
                href={previewOpenHref}
                target="_blank"
                rel="noreferrer"
              >
                打开原图
              </a>
            ) : null}
            <button type="button" className="btn btn-ghost btn-sm" onClick={closePreview}>
              关闭
            </button>
          </div>
        </div>
        <div className="studio-lightbox-media">
          <img
            src={previewSrc}
            alt={previewJob.prompt || "大图预览"}
            decoding="async"
          />
        </div>
      </div>
    </div>
  ) : null;

  if (mode === "chat") {
    return (
      <div className="page studio-chat-layout">
        <section className="panel studio-chat-card">
          <div className="studio-chat-header">
            <div className="results-toolbar">
              <div>
                <div className="panel-kicker">Chat</div>
                <h2 className="panel-title studio-wall-title">
                  对话流 · {successOnly ? wallJobs.length : stats.total} 张
                </h2>
              </div>
              <div className="results-toolbar-actions">
                <div className="kpi-row kpi-row-inline" aria-label="生成统计">
                  <div className="kpi">
                    <div className="kpi-label">总数</div>
                    <div className="kpi-value">{stats.total}</div>
                  </div>
                  <div className="kpi">
                    <div className="kpi-label">完成</div>
                    <div className="kpi-value">{stats.done}</div>
                  </div>
                </div>
                <button
                  type="button"
                  className={`chip gallery-filter-chip ${successOnly ? "active" : ""}`}
                  aria-pressed={successOnly}
                  onClick={toggleSuccessOnly}
                >
                  仅成功
                </button>
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  disabled={running || safeJobs.length === 0}
                  onClick={handleClear}
                >
                  清空
                </button>
              </div>
            </div>
            {feedbackBars}
            <div className="progress-track" aria-hidden>
              <div className="progress-fill" style={{ width: `${safeJobs.length ? progress : 0}%` }} />
            </div>
            <div className="selection-bar">
              <label className="select-all">
                <input
                  type="checkbox"
                  checked={allSelected}
                  disabled={downloadableJobs.length === 0 || downloading}
                  onChange={toggleSelectAll}
                />
                <span>{allSelected ? "取消全选" : "全选已完成"}</span>
              </label>
              <div className="selection-meta">
                已选 <strong>{selectedCount}</strong> / 可下载 {downloadableJobs.length}
              </div>
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={selectedCount === 0 || downloading}
                  onClick={clearSelection}
                >
                  清除勾选
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={selectedCount === 0 || downloading}
                  onClick={handleDownloadSelected}
                >
                  {downloading ? "下载中…" : `下载已选 (${selectedCount})`}
                </button>
              </div>
            </div>
          </div>

          <div className="studio-chat-stream">
            {safeJobs.length === 0 ? (
              <div className="empty empty-compact gallery-empty">
                <div className="empty-icon" aria-hidden />
                <div>
                  <span className="empty-title">还没有对话画面</span>
                  <p className="empty-text">在同一卡片底部输入提示词并发送。结果会按提示词分组出现在时间线里。</p>
                </div>
              </div>
            ) : promptGroups.length === 0 ? (
              <div className="empty empty-compact gallery-empty">
                <div className="empty-icon" aria-hidden />
                <div>
                  <span className="empty-title">暂无成功图片</span>
                  <p className="empty-text">已开启「仅成功」。关闭开关可查看进行中或失败任务。</p>
                </div>
              </div>
            ) : (
              promptGroups.map((group) => (
                <div key={group.prompt} className="studio-chat-turn">
                  <div className="studio-chat-user">{group.prompt}</div>
                  <div className="studio-chat-assistant">
                    <div className="gallery">{group.jobs.map((job) => renderJobCard(job))}</div>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="studio-chat-composer" aria-label="对话输入">
            <div className="field">
              <div className="label-row prompt-label-row">
                <label htmlFor="prompts-chat">Prompt</label>
                <div className="prompt-optimize-actions">
                  <div className="segmented prompt-mode-segmented" role="group" aria-label="提示词模式">
                    <button
                      type="button"
                      className={`chip ${draft.promptMode !== "block" ? "active" : ""}`}
                      disabled={optimizeBusy || running}
                      onClick={() => setDraft({ promptMode: "lines" })}
                    >
                      单行
                    </button>
                    <button
                      type="button"
                      className={`chip ${draft.promptMode === "block" ? "active" : ""}`}
                      disabled={optimizeBusy || running}
                      onClick={() => setDraft({ promptMode: "block" })}
                    >
                      多行
                    </button>
                  </div>
                  <button
                    type="button"
                    className="hall-chip prompt-optimize-btn"
                    disabled={!canOptimize}
                    onClick={() => void handleOptimizePrompt()}
                  >
                    {optimizeBusy ? "优化中…" : "优化"}
                  </button>
                  <button
                    type="button"
                    className="hall-chip"
                    disabled={promptBeforeOptimize == null || optimizeBusy || running}
                    onClick={handleUndoOptimize}
                  >
                    回退
                  </button>
                  <button
                    type="button"
                    className="hall-chip"
                    disabled={!draft.promptText || optimizeBusy || running}
                    onClick={handleClearPrompt}
                  >
                    清除
                  </button>
                </div>
              </div>
              <textarea
                id="prompts-chat"
                className="textarea"
                value={draft.promptText}
                onChange={(e) => setDraft({ promptText: e.target.value })}
                placeholder={
                  draft.promptMode === "block"
                    ? "多行模式：整段作为同一张图的提示词"
                    : "单行模式：每行一个 prompt，发送后批量生成"
                }
                disabled={optimizeBusy}
              />
              {optimizeNotice ? (
                <div
                  className={`studio-feedback ${optimizeNotice.ok ? "studio-feedback-ok" : "studio-feedback-warn"}`}
                  role="status"
                  style={{ marginTop: 10, marginBottom: 0 }}
                >
                  <span className={`studio-feedback-dot ${optimizeNotice.ok ? "ok" : "warn"}`} aria-hidden />
                  <span className="studio-feedback-text">{optimizeNotice.text}</span>
                </div>
              ) : null}
            </div>
            <div className="studio-chat-composer-actions">
              <div className="composer-stats">
                <span className="stat-pill">
                  {draft.promptMode === "block" ? "整段" : "行数"} <strong>{prompts.length}</strong>
                </span>
                <span className="stat-pill">
                  总张数 <strong>{plannedJobs}</strong>
                </span>
                {running ? <span className="stat-pill">生成中</span> : null}
              </div>
              <button
                type="button"
                className="hall-chip"
                onClick={() => setChatParamsOpen((v) => !v)}
                aria-expanded={chatParamsOpen}
              >
                {chatParamsOpen ? "收起参数" : "参数"}
              </button>
              <button type="button" className="btn btn-ghost" onClick={openConfigOrLogin}>
                模型 {settings.model || "未选择"} →
              </button>
              <div className="btn-row" style={{ marginLeft: "auto" }}>
                <button type="button" className="btn btn-secondary" disabled={!running} onClick={onStop}>
                  停止
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={running || prompts.length === 0}
                  onClick={handleGenerate}
                >
                  {running ? "生成中…" : `发送 · ${plannedJobs}`}
                </button>
              </div>
            </div>
            {chatParamsOpen ? (
              <div className="studio-chat-params">
                <div className="studio-params-grid">
                  <div className="studio-params-row">
                    <div className="field">
                      <label>数量</label>
                      <div className="segmented">
                        {VARIANT_OPTIONS.map((n) => (
                          <button
                            key={n}
                            type="button"
                            className={`chip ${draft.variants === n ? "active" : ""}`}
                            onClick={() => setDraft({ variants: n })}
                          >
                            {n}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="field">
                      <label>并发</label>
                      <div className="segmented">
                        {CONCURRENCY_OPTIONS.map((n) => (
                          <button
                            key={n}
                            type="button"
                            className={`chip ${draft.concurrency === n ? "active" : ""}`}
                            onClick={() => setDraft({ concurrency: n })}
                          >
                            {n}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="field">
                      <label>分辨率</label>
                      <div className="segmented">
                        {RESOLUTIONS.map((item) => {
                          const allowed = modelCap.allowedResolutions.includes(item);
                          return (
                            <button
                              key={item}
                              type="button"
                              className={`chip ${draft.resolution === item ? "active" : ""}`}
                              disabled={!allowed}
                              onClick={() => {
                                if (allowed) setDraft({ resolution: item });
                              }}
                            >
                              {item}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                  <div className="studio-params-divider" role="separator" />
                  <div className="field">
                    <label>宽高比</label>
                    <div className="segmented">
                      {ASPECT_RATIOS.map((ratio) => (
                        <button
                          key={ratio}
                          type="button"
                          className={`chip ${draft.aspectRatio === ratio ? "active" : ""}`}
                          onClick={() => setDraft({ aspectRatio: ratio })}
                        >
                          {ratio}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </section>
        {previewLightbox}
      </div>
    );
  }

  return (
    <div className="page studio-console-layout">
      <section className="panel studio-console-controls studio-stage">
        {feedbackBars}

        <div className="field">
          <div className="label-row prompt-label-row">
            <label htmlFor="prompts">Prompt</label>
            <div className="prompt-optimize-actions">
              <div className="segmented prompt-mode-segmented" role="group" aria-label="提示词模式">
                <button
                  type="button"
                  className={`chip ${draft.promptMode !== "block" ? "active" : ""}`}
                  disabled={optimizeBusy || running}
                  title="每行一条 prompt，分别生图"
                  onClick={() => setDraft({ promptMode: "lines" })}
                >
                  单行
                </button>
                <button
                  type="button"
                  className={`chip ${draft.promptMode === "block" ? "active" : ""}`}
                  disabled={optimizeBusy || running}
                  title="整段输入作为同一张图的提示词"
                  onClick={() => setDraft({ promptMode: "block" })}
                >
                  多行
                </button>
              </div>
              <button
                type="button"
                className="hall-chip prompt-optimize-btn"
                disabled={!canOptimize}
                title={
                  !optimizeEndpoint.model
                    ? "请先在设置页填写「提示词优化模型」"
                    : !optimizeEndpoint.apiKey || !optimizeEndpoint.baseUrl
                      ? optimizeEndpoint.usingCustomUpstream
                        ? "请填写独立优化 API Base / Key"
                        : "请先配置生图 API"
                      : !draft.promptText.trim()
                        ? "请先输入提示词"
                        : "调用 chat 模型优化当前提示词"
                }
                onClick={() => void handleOptimizePrompt()}
              >
                {optimizeBusy ? "优化中…" : "优化提示词"}
              </button>
              <button
                type="button"
                className="hall-chip"
                disabled={promptBeforeOptimize == null || optimizeBusy || running}
                title="恢复到本次优化前的内容"
                onClick={handleUndoOptimize}
              >
                回退
              </button>
              <button
                type="button"
                className="hall-chip"
                disabled={!draft.promptText || optimizeBusy || running}
                title="清空输入框"
                onClick={handleClearPrompt}
              >
                清除
              </button>
            </div>
          </div>
          <textarea
            id="prompts"
            className="textarea"
            value={draft.promptText}
            onChange={(e) => setDraft({ promptText: e.target.value })}
            placeholder={
              draft.promptMode === "block"
                ? "多行模式：整段内容作为同一张图的提示词\n可换行描述细节、风格、构图…"
                : "单行模式：每行一个 prompt\n例如：cyberpunk city at night\na watercolor fox"
            }
            disabled={optimizeBusy}
          />
          {optimizeNotice ? (
            <div
              className={`studio-feedback ${optimizeNotice.ok ? "studio-feedback-ok" : "studio-feedback-warn"}`}
              role="status"
              style={{ marginTop: 10, marginBottom: 0 }}
            >
              <span
                className={`studio-feedback-dot ${optimizeNotice.ok ? "ok" : "warn"}`}
                aria-hidden
              />
              <span className="studio-feedback-text">{optimizeNotice.text}</span>
            </div>
          ) : null}
          <div className="composer-stats">
            <span
              className="stat-pill"
              title={
                draft.promptMode === "block"
                  ? "多行模式：整段算 1 条 prompt"
                  : "单行模式：非空行数"
              }
            >
              {draft.promptMode === "block" ? "整段" : "行数"}{" "}
              <strong>{prompts.length}</strong>
            </span>
            <span className="stat-pill" title="生图数量（variants）">
              生图 <strong>{draft.variants}</strong>
            </span>
            <span className="stat-pill" title="同时请求数，也会乘进总张数">
              并发 <strong>{draft.concurrency}</strong>
            </span>
            <span
              className="stat-pill"
              title={
                draft.promptMode === "block"
                  ? "总张数 = 1 × 生图数量 × 并发数"
                  : "总张数 = Prompt 条数 × 生图数量 × 并发数"
              }
            >
              总张数 <strong>{plannedJobs}</strong>
            </span>
            {running ? <span className="stat-pill">生成中</span> : null}
          </div>
        </div>

        <div className="studio-options">
          {/* 操作 + 参数合并为一张玻璃卡片，风格统一 */}
          <div className="option-block option-block-studio">
            <div className="studio-toolbar">
              <div className="btn-row studio-toolbar-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={running || prompts.length === 0}
                  onClick={handleGenerate}
                >
                  {running ? "生成中…" : `开始生成 · ${plannedJobs}`}
                </button>
                <button type="button" className="btn btn-secondary" disabled={!running} onClick={onStop}>
                  停止
                </button>
              </div>
              <button type="button" className="btn btn-ghost studio-toolbar-model" onClick={openConfigOrLogin}>
                模型 {settings.model || "未选择"} →
              </button>
            </div>

            <div className="studio-params-divider" role="separator" />

            <div className="studio-params-grid">
              <div className="studio-params-row">
                <div className="field">
                  <label>数量</label>
                  <div className="segmented">
                    {VARIANT_OPTIONS.map((n) => (
                      <button
                        key={n}
                        type="button"
                        className={`chip ${draft.variants === n ? "active" : ""}`}
                        onClick={() => setDraft({ variants: n })}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="studio-params-vsep" role="separator" aria-orientation="vertical" />
                <div className="field">
                  <label>并发</label>
                  <div className="segmented">
                    {CONCURRENCY_OPTIONS.map((n) => (
                      <button
                        key={n}
                        type="button"
                        className={`chip ${draft.concurrency === n ? "active" : ""}`}
                        onClick={() => setDraft({ concurrency: n })}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="studio-params-vsep" role="separator" aria-orientation="vertical" />
                <div className="field">
                  <label>分辨率</label>
                  <div className="segmented">
                    {RESOLUTIONS.map((item) => {
                      const allowed = modelCap.allowedResolutions.includes(item);
                      return (
                        <button
                          key={item}
                          type="button"
                          className={`chip ${draft.resolution === item ? "active" : ""}`}
                          disabled={!allowed}
                          title={allowed ? item : `${settings.model} 不支持 ${item}`}
                          onClick={() => {
                            if (allowed) setDraft({ resolution: item });
                          }}
                        >
                          {item}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
              <div className="studio-params-divider" role="separator" />
              <div className="studio-params-row studio-params-row-aspect">
                <div className="field">
                  <label>宽高比</label>
                  <div className="segmented">
                    {ASPECT_RATIOS.map((ratio) => (
                      <button
                        key={ratio}
                        type="button"
                        className={`chip ${draft.aspectRatio === ratio ? "active" : ""}`}
                        onClick={() => setDraft({ aspectRatio: ratio })}
                      >
                        {ratio}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="panel results-panel studio-wall studio-console-wall">
        <div className="results-toolbar">
          <div>
            <div className="panel-kicker">Results</div>
            <h2 className="panel-title studio-wall-title">
              图片墙 · {successOnly ? wallJobs.length : stats.total} 张
              {successOnly && stats.total > wallJobs.length ? (
                <span className="studio-wall-filter-hint">（仅成功）</span>
              ) : null}
            </h2>
          </div>
          <div className="results-toolbar-actions">
            {/* KPI 始终占位，避免点生成后工具栏突然插入导致图片墙下移 */}
            <div className="kpi-row kpi-row-inline" aria-label="生成统计">
              <div className="kpi">
                <div className="kpi-label">总数</div>
                <div className="kpi-value">{stats.total}</div>
              </div>
              <div className="kpi">
                <div className="kpi-label">完成</div>
                <div className="kpi-value">{stats.done}</div>
              </div>
            </div>
            <button
              type="button"
              className={`chip gallery-filter-chip ${successOnly ? "active" : ""}`}
              aria-pressed={successOnly}
              title={successOnly ? "当前仅显示生成成功" : "显示全部（含进行中/失败）"}
              onClick={toggleSuccessOnly}
            >
              仅成功
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={running || safeJobs.length === 0}
              onClick={handleClear}
            >
              清空
            </button>
          </div>
        </div>

        {/* 进度条 / 选择栏始终占位，开始生成时只换 gallery 内容，避免整体位移 */}
        <div className="progress-track" aria-hidden>
          <div className="progress-fill" style={{ width: `${safeJobs.length ? progress : 0}%` }} />
        </div>

        <div className="selection-bar">
          <label className="select-all">
            <input
              type="checkbox"
              checked={allSelected}
              disabled={downloadableJobs.length === 0 || downloading}
              onChange={toggleSelectAll}
            />
            <span>{allSelected ? "取消全选" : "全选已完成"}</span>
          </label>
          <div className="selection-meta">
            已选 <strong>{selectedCount}</strong> / 可下载 {downloadableJobs.length}
          </div>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={selectedCount === 0 || downloading}
              onClick={clearSelection}
            >
              清除勾选
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={selectedCount === 0 || downloading}
              onClick={handleDownloadSelected}
            >
              {downloading ? "下载中…" : `下载已选 (${selectedCount})`}
            </button>
          </div>
        </div>

        {safeJobs.length === 0 ? (
          <div className="empty empty-compact gallery-empty">
            <div className="empty-icon" aria-hidden />
            <div>
              <span className="empty-title">还没有画面</span>
              <p className="empty-text">写好提示词后点「开始生成」。结果与队列会自动保留。</p>
            </div>
          </div>
        ) : wallJobs.length === 0 ? (
          <div className="empty empty-compact gallery-empty">
            <div className="empty-icon" aria-hidden />
            <div>
              <span className="empty-title">暂无成功图片</span>
              <p className="empty-text">已开启「仅成功」。关闭开关可查看进行中或失败任务。</p>
            </div>
          </div>
        ) : (
          <div className="gallery">{wallJobs.map((job) => renderJobCard(job))}</div>
        )}
      </section>
      {previewLightbox}
    </div>
  );
}
