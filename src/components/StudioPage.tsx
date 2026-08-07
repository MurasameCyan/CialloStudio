import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, ImagePlus, RefreshCw, Server, Sparkles, Video } from "lucide-react";
import { ShareCooldownBanner, isShareCooling } from "@/components/ShareCooldownBanner";
import { ApiError, optimizePromptText } from "@/lib/api";
import { communityApi } from "@/lib/community/client";
import { openOriginalImageInNewTab } from "@/lib/community/postImage";
import {
  computeShareRemainSec,
  type ShareStatus,
} from "@/lib/community/types";
import { downloadJobs } from "@/lib/download";
import { getImageModelCapability, isImageEditModel } from "@/lib/imageModels";
import { log } from "@/lib/logger";
import { isMediaConfigured, uploadMedia } from "@/lib/media/client";
import { describeMediaMeta, type MediaMeta } from "@/lib/mediaMeta";
import {
  loadPromptHistory,
  promptHistoryPreview,
  pushPromptHistory,
  savePromptHistory,
  type PromptHistoryItem,
} from "@/lib/promptHistory";
import {
  ASPECT_RATIOS,
  RESOLUTIONS,
  SOURCE_ASPECT_RATIO,
  VIDEO_DURATIONS,
  VIDEO_RESOLUTIONS,
  resolveGenerationAspectRatio,
  resolvePromptOptimizeEndpoint,
  type StudioSettings,
} from "@/lib/settings";
import {
  VARIANT_OPTIONS,
  concurrencyOptionsForCap,
  displayUrl,
  type StudioDraft,
  type StudioJob,
} from "@/lib/studioQueue";
import type { ServerQueueItem } from "@/hooks/useStudioQueue";
import type { StudioMode } from "@/lib/studioMode";

/** 新标签页打开媒体；复用大厅那套 blob HTML 包装（裸 GET 带不上 Authorization） */
function openMediaInNewTab(url: string, isVideo: boolean): void {
  if (!url) return;
  const ok = openOriginalImageInNewTab(url, isVideo ? "视频预览" : "原图预览", isVideo);
  if (!ok) log("warn", "媒体地址不可用或弹窗被拦截");
}

/** 创作台生成模式：文生图 / 图生图 / 视频，三选一 */
type GenMode = "text" | "edit" | "video";

type ReferenceImageSize = { width: number; height: number };

function measureReferenceImage(
  src: string,
  onSuccess: (size: ReferenceImageSize) => void,
  onError?: () => void,
): void {
  const image = new window.Image();
  image.onload = () => {
    if (image.naturalWidth > 0 && image.naturalHeight > 0) {
      onSuccess({ width: image.naturalWidth, height: image.naturalHeight });
    } else {
      onError?.();
    }
  };
  image.onerror = () => onError?.();
  image.src = src;
}

const MediaMetaSpecs = memo(function MediaMetaSpecs({
  meta,
  isVideo,
}: {
  meta: MediaMeta | undefined;
  isVideo: boolean;
}) {
  const chips = describeMediaMeta(meta, isVideo);
  if (chips.length === 0) return null;
  return (
    <span className="card-specs" aria-label="实际产物参数">
      {chips.map((chip) => (
        <span key={chip} className="card-spec">
          {chip}
        </span>
      ))}
    </span>
  );
});

const StudioJobCard = memo(function StudioJobCard({
  job,
  selected,
  downloading,
  sharingId,
  shareLocked,
  alreadyShared,
  allowReference,
  onToggle,
  onPreview,
  onUseAsReference,
  onShare,
}: {
  job: StudioJob;
  selected: boolean;
  downloading: boolean;
  sharingId: string | null;
  shareLocked: boolean;
  alreadyShared: boolean;
  allowReference: boolean;
  onToggle: (id: string) => void;
  onPreview: (job: StudioJob) => void;
  onUseAsReference: (job: StudioJob) => void;
  onShare: (job: StudioJob) => void;
}) {
  const src = displayUrl(job);
  const isVideo = job.kind === "video";
  // 实际产物参数从加载完成的媒体元素上量，并绑定当前 src，避免换源时闪出旧参数
  const [measured, setMeasured] = useState<{ src: string; meta: MediaMeta } | undefined>(undefined);
  const meta = measured && measured.src === src ? measured.meta : undefined;
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
        title={canSelect ? "单击选中 · 双击大图" : undefined}
        onClick={() => {
          if (canSelect) onToggle(job.id);
        }}
        onDoubleClick={(e) => {
          if (!(job.status === "done" && src)) return;
          e.preventDefault();
          e.stopPropagation();
          onPreview(job);
        }}
      >
        {job.status === "done" && src ? (
          <>
            {isVideo ? (
              <video
                src={src}
                controls
                loop
                muted
                playsInline
                preload="metadata"
                aria-label={`${job.prompt} #${job.variant}`}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onLoadedMetadata={(e) => {
                  const el = e.currentTarget;
                  setMeasured({
                    src: el.currentSrc || el.src,
                    meta: {
                      width: el.videoWidth,
                      height: el.videoHeight,
                      duration: Number.isFinite(el.duration) ? el.duration : job.duration,
                    },
                  });
                }}
              />
            ) : (
              <img
                src={src}
                alt={`${job.prompt} #${job.variant}`}
                loading="lazy"
                decoding="async"
                draggable={false}
                onLoad={(e) => {
                  const el = e.currentTarget;
                  setMeasured({
                    src: el.currentSrc || el.src,
                    meta: { width: el.naturalWidth, height: el.naturalHeight },
                  });
                }}
              />
            )}
            <div className="card-overlay">
              <button
                type="button"
                className="card-overlay-action"
                title={isVideo ? "新标签页播放" : "新标签页查看"}
                onClick={(e) => {
                  e.stopPropagation();
                  openMediaInNewTab(src, isVideo);
                }}
              >
                {isVideo ? "打开视频" : "打开原图"}
              </button>
              <button
                type="button"
                className="card-overlay-action"
                title={isVideo ? "页内大屏播放" : "页内大图预览"}
                onClick={(e) => {
                  e.stopPropagation();
                  onPreview(job);
                }}
              >
                {isVideo ? "大屏播放" : "显示大图"}
              </button>
              {allowReference && !isVideo ? (
                <button
                  type="button"
                  className="card-overlay-action"
                  title="用作图+文参考图"
                  onClick={(e) => {
                    e.stopPropagation();
                    onUseAsReference(job);
                  }}
                >
                  作参考
                </button>
              ) : null}
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
          // 视频异步生成较久：把进度/重试提示显示在骨架屏上
          <div className="skeleton" style={{ display: "grid", placeItems: "center", padding: 16 }}>
            {job.error ? (
              <span
                style={{ color: "var(--text-muted)", fontSize: 12, textAlign: "center" }}
                aria-live="polite"
              >
                {job.error}
              </span>
            ) : null}
          </div>
        )}
      </div>
      <div className="card-body">
        <div className="card-meta">
          <strong>#{job.variant}</strong>
          {job.prompt}
        </div>
        <MediaMetaSpecs meta={meta} isVideo={isVideo} />
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
  /** 后台任务开关：站长/VIP 或站长开启的普通用户 */
  canBackgroundTasks?: boolean;
  /** 当前用户组并发上限（>2 时显示对应并发按钮） */
  concurrencyCap?: number;
  draft: StudioDraft;
  setDraft: (patch: Partial<StudioDraft>) => void;
  jobs: StudioJob[];
  /** 浏览器本地生成中；服务端后台入队不置 true */
  running: boolean;
  /** 正在提交服务端队列（短暂） */
  enqueueBusy?: boolean;
  queueNotice?: { ok: boolean; text: string } | null;
  onClearQueueNotice?: () => void;
  serverMode?: boolean;
  serverQueue?: ServerQueueItem[];
  onRefreshServerQueue?: () => void;
  onCancelServerQueueItem?: (serverTaskId: string) => Promise<void>;
  onClearServerQueue?: (mode: "cancel_all" | "clear_failed" | "clear_all") => Promise<void>;
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
  canBackgroundTasks = false,
  concurrencyCap = 2,
  draft,
  setDraft,
  jobs,
  running,
  enqueueBusy = false,
  queueNotice = null,
  onClearQueueNotice,
  serverMode = false,
  serverQueue = [],
  onRefreshServerQueue,
  onCancelServerQueueItem,
  onClearServerQueue,
  prompts,
  plannedJobs,
  stats,
  progress,
  onStart,
  onStop,
  onClear,
}: Props) {
  const [serverQueueOpen, setServerQueueOpen] = useState(false);
  const [cancelingServerId, setCancelingServerId] = useState<string | null>(null);
  const [queueBulkBusy, setQueueBulkBusy] = useState<string | null>(null);
  /** 视频模式：管理页配了视频模型 + 用户在创作台切到视频 */
  const videoEnabled = Boolean((settings.videoModel ?? "").trim());
  const videoMode = videoEnabled && draft.videoMode === true;
  /** 图生图功能可用 = 管理页配了图生图模型 */
  const imageEditEnabled = Boolean((settings.imageEditModel ?? "").trim());
  /** 服务端后台：生成按钮不因 running 锁死，仅入队瞬间 busy */
  const generateLocked = running || enqueueBusy;
  const stopEnabled = running || serverMode;
  const concurrencyOptions = useMemo(
    () => concurrencyOptionsForCap(concurrencyCap),
    [concurrencyCap],
  );
  /** 文生图槽本身填的就是编辑类模型（必须带图）→ 强制留在图生图 */
  const referenceForced = isImageEditModel(typeof settings.model === "string" ? settings.model : "");
  /** 图生图模式：配了图生图模型且用户切过去；文生图槽是编辑类模型时强制生效 */
  const imageEditMode =
    !videoMode && (referenceForced || (imageEditEnabled && draft.imageEditMode === true));
  /** 创作台当前模式，三选一；下方参数区按它切换 */
  const genMode: GenMode = videoMode ? "video" : imageEditMode ? "edit" : "text";
  const sourceAspectRatio = resolveGenerationAspectRatio(
    SOURCE_ASPECT_RATIO,
    draft.referenceImageWidth,
    draft.referenceImageHeight,
  );
  const sourceRatioEnabled = Boolean(draft.referenceImageUrl && sourceAspectRatio);

  /**
   * 模式切换：只要图标，名字走 hover 提示（data-tip）。
   * 切到/离开视频时套用管理页对应的默认宽高比（图片与视频常用比例不同）。
   */
  const pickGenMode = (next: GenMode) => {
    if (next === genMode) return;
    if (next === "video") {
      setDraft({ videoMode: true, aspectRatio: settings.videoAspectRatio });
      return;
    }
    setDraft({
      videoMode: false,
      imageEditMode: next === "edit",
      aspectRatio:
        videoMode || draft.aspectRatio === SOURCE_ASPECT_RATIO
          ? settings.aspectRatio
          : draft.aspectRatio,
    });
  };

  const genModeOptions: {
    key: GenMode;
    label: string;
    tip: string;
    available: boolean;
    Icon: typeof Sparkles;
  }[] = [
    {
      key: "text",
      label: "文生图",
      tip: referenceForced ? `文生图模型「${settings.model}」必须带参考图` : "文生图",
      available: !referenceForced,
      Icon: Sparkles,
    },
    {
      key: "edit",
      label: "图生图",
      tip: "图生图",
      available: imageEditEnabled || referenceForced,
      Icon: ImagePlus,
    },
    { key: "video", label: "视频", tip: "视频", available: videoEnabled, Icon: Video },
  ];
  const availableGenModes = genModeOptions.filter((item) => item.available);
  /** 只有一种模式可用时不显示切换器（没什么可切） */
  const genModeSwitch =
    availableGenModes.length > 1 ? (
      <div className="studio-mode-switch" role="group" aria-label="生成模式">
        {availableGenModes.map(({ key, label, tip, Icon }) => (
          <button
            key={key}
            type="button"
            className={`studio-mode-btn ${genMode === key ? "active" : ""}`}
            aria-pressed={genMode === key}
            aria-label={label}
            data-tip={tip}
            onClick={() => pickGenMode(key)}
          >
            <Icon size={17} strokeWidth={2} aria-hidden />
          </button>
        ))}
      </div>
    ) : null;

  /** 实际生图模型：带参考图且配了图生图模型时走图生图（与 resolveGenerationTarget 一致） */
  const activeImageModel =
    draft.referenceImageUrl && (settings.imageEditModel ?? "").trim()
      ? settings.imageEditModel.trim()
      : settings.model;
  // resolutionField 是立即构造的 JSX，里面的 .map() 当场就读 modelCap，
  // 所以必须声明在它之前，否则 TDZ。
  const modelCap = useMemo(() => getImageModelCapability(activeImageModel), [activeImageModel]);
  /** 高级开关：与模式切换器同风格的图标按钮，并排在「开始生成 · 停止」右侧 */
  const advancedSwitch = (
    <div className="studio-mode-switch" role="group" aria-label="高级">
      <button
        type="button"
        className="studio-mode-btn"
        aria-pressed={draft.autoRetry}
        aria-label="自动重试"
        data-tip="自动重试"
        title="开启后，失败的子任务会自动重试，直到生成成功或你点击停止"
        onClick={() => setDraft({ autoRetry: !draft.autoRetry })}
      >
        <RefreshCw size={17} strokeWidth={2} aria-hidden />
      </button>
      {canBackgroundTasks ? (
        <button
          type="button"
          className="studio-mode-btn"
          aria-pressed={draft.backgroundTasks}
          aria-label="后台任务"
          data-tip="后台任务"
          title="提交到服务端队列，关浏览器也可续跑；点生成直接入队且不锁按钮"
          onClick={() => setDraft({ backgroundTasks: !draft.backgroundTasks })}
        >
          <Server size={17} strokeWidth={2} aria-hidden />
        </button>
      ) : null}
    </div>
  );

  /** 宽高比：图生图/图生视频有参考图时可按最接近的受支持源比例生成 */
  const aspectRatioField = (
    <div className="field">
      <label>宽高比</label>
      <div className="segmented">
        {(imageEditMode || videoMode) ? (
          <button
            type="button"
            className={`chip ${draft.aspectRatio === SOURCE_ASPECT_RATIO ? "active" : ""}`}
            disabled={!sourceRatioEnabled}
            title={sourceRatioEnabled ? `按参考图最接近的支持比例生成（${sourceAspectRatio}）` : "上传参考图后可用"}
            onClick={() => setDraft({ aspectRatio: SOURCE_ASPECT_RATIO })}
          >
            源
          </button>
        ) : null}
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
  );

  /** 分辨率：视频模式换成 480p/720p/1080p；控制台与对话共用 */
  const resolutionField = (
    <div className="field">
      <label>分辨率</label>
      <div className="segmented">
        {videoMode
          ? VIDEO_RESOLUTIONS.map((item) => (
              <button
                key={item}
                type="button"
                className={`chip ${draft.videoResolution === item ? "active" : ""}`}
                title={`视频分辨率 ${item}`}
                onClick={() => setDraft({ videoResolution: item })}
              >
                {item}
              </button>
            ))
          : RESOLUTIONS.map((item) => {
              const allowed = modelCap.allowedResolutions.includes(item);
              return (
                <button
                  key={item}
                  type="button"
                  className={`chip ${draft.resolution === item ? "active" : ""}`}
                  disabled={!allowed}
                  title={allowed ? item : `${activeImageModel} 不支持 ${item}`}
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
  );

  /** 视频时长：仅视频模式出现 */
  const videoDurationField = videoMode ? (
    <div className="field">
      <label>时长</label>
      <div className="segmented">
        {VIDEO_DURATIONS.map((item) => (
          <button
            key={item}
            type="button"
            className={`chip ${draft.videoDuration === item ? "active" : ""}`}
            title={`${item} 秒`}
            onClick={() => setDraft({ videoDuration: item })}
          >
            {item}s
          </button>
        ))}
      </div>
    </div>
  ) : null;

  const serverQueueActiveCount = serverQueue.filter(
    (t) => t.status === "queued" || t.status === "running",
  ).length;
  const serverQueueFailedCount = serverQueue.filter(
    (t) => t.status === "failed" || t.status === "cancelled",
  ).length;

  const queueToggleButton = canBackgroundTasks ? (
    <button
      type="button"
      className={`chip gallery-filter-chip studio-queue-chip ${serverQueueOpen || serverQueueActiveCount > 0 ? "active" : ""}`}
      aria-expanded={serverQueueOpen}
      title="服务端后台队列：开启后台任务后点生成会直接入队"
      onClick={() => {
        const next = !serverQueueOpen;
        setServerQueueOpen(next);
        if (next) onRefreshServerQueue?.();
      }}
    >
      队列
      {serverQueueActiveCount > 0 ? (
        <strong className="studio-server-queue-count">{serverQueueActiveCount}</strong>
      ) : null}
    </button>
  ) : null;

  async function runQueueBulk(mode: "cancel_all" | "clear_failed" | "clear_all") {
    if (!onClearServerQueue || queueBulkBusy) return;
    if (mode === "clear_all") {
      const ok = window.confirm("确定清除全部服务端任务？进行中的会先取消，记录将删除。");
      if (!ok) return;
    }
    if (mode === "cancel_all" && serverQueueActiveCount === 0) return;
    if (mode === "clear_failed" && serverQueueFailedCount === 0) return;
    setQueueBulkBusy(mode);
    try {
      await onClearServerQueue(mode);
    } catch (e) {
      log("error", "队列批量操作失败", e instanceof Error ? e.message : String(e));
    } finally {
      setQueueBulkBusy(null);
    }
  }

  /** 展开后在作品墙区域展示队列详情（替换/覆盖 gallery 上方内容） */
  const serverQueueDetail =
    canBackgroundTasks && serverQueueOpen ? (
      <div className="studio-server-queue studio-server-queue-wall studio-server-queue-detail" role="region" aria-label="服务端队列详情">
        <div className="studio-server-queue-toolbar">
          <div className="studio-server-queue-toolbar-left">
            <span className="studio-server-queue-title">
              队列详情
              {serverQueueActiveCount > 0 ? (
                <strong className="studio-server-queue-count">{serverQueueActiveCount}</strong>
              ) : null}
            </span>
            {serverMode ? <span className="studio-server-queue-hint">同步中</span> : null}
          </div>
          <div className="studio-server-queue-toolbar-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={Boolean(queueBulkBusy)}
              onClick={() => onRefreshServerQueue?.()}
            >
              刷新
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={Boolean(queueBulkBusy) || serverQueueActiveCount === 0}
              onClick={() => void runQueueBulk("cancel_all")}
            >
              {queueBulkBusy === "cancel_all" ? "取消中…" : "取消全部"}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={Boolean(queueBulkBusy) || serverQueueFailedCount === 0}
              onClick={() => void runQueueBulk("clear_failed")}
            >
              {queueBulkBusy === "clear_failed" ? "清除中…" : "清除失败"}
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={Boolean(queueBulkBusy) || serverQueue.length === 0}
              onClick={() => void runQueueBulk("clear_all")}
            >
              {queueBulkBusy === "clear_all" ? "清除中…" : "清除全部"}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setServerQueueOpen(false)}
            >
              收起
            </button>
          </div>
        </div>
        {serverQueue.length === 0 ? (
          <p className="studio-server-queue-empty">
            暂无服务端任务 · 开启「后台任务」并点生成后会出现在这里
          </p>
        ) : (
          <ul className="studio-server-queue-list">
            {serverQueue.map((item) => {
              const statusLabel =
                item.status === "queued"
                  ? "排队"
                  : item.status === "running"
                    ? "生成中"
                    : item.status === "done"
                      ? "完成"
                      : item.status === "cancelled"
                        ? "已取消"
                        : "失败";
              const canCancel = item.status === "queued" || item.status === "running";
              return (
                <li key={item.id} className={`studio-server-queue-item is-${item.status}`}>
                  <div className="studio-server-queue-row">
                    <div className="studio-server-queue-main">
                      <span className={`studio-server-queue-badge is-${item.status}`}>{statusLabel}</span>
                      <span className="studio-server-queue-prompt" title={item.prompt}>
                        #{item.variant}/{item.variants} · {item.prompt}
                      </span>
                    </div>
                    <div className="studio-server-queue-meta">
                      {item.attempt > 1 ? <span>重试 {item.attempt}</span> : null}
                      {item.error ? (
                        <span className="studio-server-queue-error" title={item.error}>
                          {item.error}
                        </span>
                      ) : null}
                    </div>
                    <div className="studio-server-queue-actions">
                      {canCancel && onCancelServerQueueItem ? (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={cancelingServerId === item.id || Boolean(queueBulkBusy)}
                          onClick={() => {
                            setCancelingServerId(item.id);
                            void onCancelServerQueueItem(item.id)
                              .catch(() => undefined)
                              .finally(() => setCancelingServerId(null));
                          }}
                        >
                          {cancelingServerId === item.id ? "取消中…" : "取消"}
                        </button>
                      ) : (
                        <span className="studio-server-queue-action-spacer" aria-hidden>
                          —
                        </span>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    ) : null;

  /** 仅展示失败/警告类队列提示；成功类（清除/入队）不打扰创作台 */
  const queueNoticeBanner =
    queueNotice && !queueNotice.ok ? (
      <div className="studio-feedback studio-feedback-warn studio-queue-notice" role="status">
        <span className="studio-feedback-dot warn" aria-hidden />
        <span className="studio-feedback-text">{queueNotice.text}</span>
        {onClearQueueNotice ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClearQueueNotice}>
            关闭
          </button>
        ) : null}
      </div>
    ) : null;
  const configured = Boolean((typeof settings.apiKey === "string" ? settings.apiKey : "").trim());
  /**
   * 参考图上传区：跟着模式走。
   * - 图生图：显示（这就是该模式的核心输入）
   * - 视频：配了图生图模型时显示，参考图作首帧（图生视频）
   * - 文生图：不显示
   */
  const showReferencePicker = useMemo(
    () => (videoMode ? imageEditEnabled : imageEditMode),
    [videoMode, imageEditEnabled, imageEditMode],
  );
  /** 编辑类模型缺参考图会被上游拒绝；视频/普通生图留空则退化为纯文生成 */
  const referenceRequired = useMemo(
    () => imageEditMode && !videoMode && referenceForced,
    [imageEditMode, videoMode, referenceForced],
  );
  /** 只允许最后一次参考图选择提交，避免慢图片覆盖后选图片或“清除” */
  const referenceLoadIdRef = useRef(0);

  // 切到文生图 / 视频时清掉参考图
  useEffect(() => {
    if (showReferencePicker) return;
    if (!draft.referenceImageUrl && !draft.referenceImageName) return;
    referenceLoadIdRef.current += 1;
    setDraft({
      referenceImageUrl: undefined,
      referenceImageName: undefined,
      referenceImageWidth: undefined,
      referenceImageHeight: undefined,
      aspectRatio: draft.aspectRatio === SOURCE_ASPECT_RATIO ? settings.aspectRatio : draft.aspectRatio,
    });
    setReferenceError(null);
    if (referenceInputRef.current) referenceInputRef.current.value = "";
    if (referenceInputChatRef.current) referenceInputChatRef.current.value = "";
  }, [
    showReferencePicker,
    draft.referenceImageUrl,
    draft.referenceImageName,
    draft.aspectRatio,
    settings.aspectRatio,
    setDraft,
  ]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [downloading, setDownloading] = useState(false);
  const [sharingId, setSharingId] = useState<string | null>(null);
  /** 本会话已成功分享过的 job id，禁止重复点分享 */
  const [sharedJobIds, setSharedJobIds] = useState<Set<string>>(() => new Set());
  const [previewJob, setPreviewJob] = useState<StudioJob | null>(null);
  /** 预览里量到的实际产物参数，绑定 job id，避免切换时闪出上一件作品的数据 */
  const [measuredPreview, setMeasuredPreview] = useState<
    { jobId: string; meta: MediaMeta } | undefined
  >(undefined);
  const [shareStatus, setShareStatus] = useState<ShareStatus | null>(null);
  /** 仅在用户点过「分享到大厅」后展示冷却/结果条，默认不占位 */
  const [shareUiRevealed, setShareUiRevealed] = useState(false);
  const [shareNotice, setShareNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [optimizeBusy, setOptimizeBusy] = useState(false);
  /** 优化前快照，供「回退」一次 */
  const [promptBeforeOptimize, setPromptBeforeOptimize] = useState<string | null>(null);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const [promptHistory, setPromptHistory] = useState<PromptHistoryItem[]>(() => loadPromptHistory());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyPanelStyle, setHistoryPanelStyle] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const referenceInputRef = useRef<HTMLInputElement | null>(null);
  const referenceInputChatRef = useRef<HTMLInputElement | null>(null);
  const historyWrapRef = useRef<HTMLDivElement | null>(null);
  const historyPanelRef = useRef<HTMLDivElement | null>(null);
  const [optimizeNotice, setOptimizeNotice] = useState<{ ok: boolean; text: string } | null>(null);
  /** 作品墙：仅展示 status=done 的卡片 */
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

  /** 大图可切换列表：当前墙里有可展示图的任务 */
  const previewableJobs = useMemo(
    () =>
      wallJobs.filter((job) => {
        if (!job || job.status !== "done") return false;
        return Boolean(
          (typeof job.imageUrl === "string" && job.imageUrl) ||
            displayUrl(job) ||
            job.openUrl,
        );
      }),
    [wallJobs],
  );

  const previewIndex = useMemo(() => {
    if (!previewJob) return -1;
    return previewableJobs.findIndex((j) => j.id === previewJob.id);
  }, [previewJob, previewableJobs]);

  const canPreviewPrev = previewIndex > 0;
  const canPreviewNext = previewIndex >= 0 && previewIndex < previewableJobs.length - 1;

  const stepPreview = useCallback(
    (delta: number) => {
      if (previewIndex < 0) return;
      const next = previewableJobs[previewIndex + delta];
      if (next) setPreviewJob(next);
    },
    [previewIndex, previewableJobs],
  );

  useEffect(() => {
    if (!previewJob) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setPreviewJob(null);
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        stepPreview(-1);
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        stepPreview(1);
      }
    }
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [previewJob, stepPreview]);

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
    if (generateLocked) return;
    if (draft.promptText.trim()) rememberPrompt(draft.promptText);
    try {
      await onStart();
      // 后台入队成功后自动展开作品墙队列，方便看到状态
      if (draft.backgroundTasks && canBackgroundTasks) {
        setServerQueueOpen(true);
      }
    } catch (error) {
      const message = error instanceof ApiError ? error.message : error instanceof Error ? error.message : "启动失败";
      log("error", "启动生成失败", message);
    }
  }

  function generateButtonLabel(prefix: "开始生成" | "发送"): string {
    if (enqueueBusy) return "入队中…";
    if (running) return "生成中…";
    if (draft.backgroundTasks && canBackgroundTasks) {
      return `${prefix === "发送" ? "入队" : "入队生成"} · ${plannedJobs}`;
    }
    return `${prefix} · ${plannedJobs}`;
  }

  function updateHistoryPanelPosition() {
    const anchor = historyWrapRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const pad = 12;
    const gap = 8;
    const width = Math.min(420, Math.max(280, window.innerWidth - pad * 2));
    const spaceBelow = window.innerHeight - rect.bottom - gap - pad;
    const spaceAbove = rect.top - gap - pad;
    const preferBelow = spaceBelow >= 200 || spaceBelow >= spaceAbove;
    const maxHeight = Math.min(360, Math.max(160, preferBelow ? spaceBelow : spaceAbove));
    let left = rect.right - width;
    left = Math.max(pad, Math.min(left, window.innerWidth - width - pad));
    const top = preferBelow ? rect.bottom + gap : Math.max(pad, rect.top - gap - maxHeight);
    setHistoryPanelStyle({ top, left, width, maxHeight });
  }

  const promptHistoryPanel =
    historyOpen && historyPanelStyle
      ? createPortal(
          <div
            ref={historyPanelRef}
            className="prompt-history-panel"
            role="listbox"
            aria-label="历史提示词"
            style={{
              top: historyPanelStyle.top,
              left: historyPanelStyle.left,
              width: historyPanelStyle.width,
              maxHeight: historyPanelStyle.maxHeight,
            }}
          >
            {promptHistory.length === 0 ? (
              <div className="prompt-history-empty">暂无历史 · 生成或优化后会自动记录</div>
            ) : (
              <>
                <div className="prompt-history-list">
                  {promptHistory.map((item, index) => (
                    <button
                      key={item.id}
                      type="button"
                      role="option"
                      className="prompt-history-item"
                      title={item.text}
                      onClick={() => applyHistoryPrompt(item)}
                    >
                      <span className="prompt-history-index">{index + 1}</span>
                      <span className="prompt-history-text">{promptHistoryPreview(item.text)}</span>
                    </button>
                  ))}
                </div>
                <div className="prompt-history-footer">
                  <button type="button" className="hall-chip" onClick={clearPromptHistory}>
                    清空历史
                  </button>
                </div>
              </>
            )}
          </div>,
          document.body,
        )
      : null;

  const promptHistoryMenu = (
    <div className="prompt-history" ref={historyWrapRef}>
      <button
        type="button"
        className={`hall-chip ${historyOpen ? "active" : ""}`}
        disabled={optimizeBusy || running}
        aria-expanded={historyOpen}
        aria-haspopup="listbox"
        title={promptHistory.length ? `历史提示词 ${promptHistory.length} 条` : "暂无历史提示词"}
        onClick={() => setHistoryOpen((v) => !v)}
      >
        历史
        <span className="prompt-history-count" aria-hidden>
          {promptHistory.length > 0 ? promptHistory.length : "·"}
        </span>
      </button>
      {promptHistoryPanel}
    </div>
  );

  function rememberPrompt(text: string) {
    setPromptHistory((prev) => {
      const next = pushPromptHistory(prev, text);
      if (next !== prev) savePromptHistory(next);
      return next;
    });
  }

  function applyHistoryPrompt(item: PromptHistoryItem) {
    setDraft({ promptText: item.text });
    setPromptBeforeOptimize(null);
    setOptimizeNotice({ ok: true, text: "已载入历史提示词" });
    setHistoryOpen(false);
    log("info", "载入历史提示词", { id: item.id, preview: promptHistoryPreview(item.text, 40) });
  }

  function clearPromptHistory() {
    setPromptHistory([]);
    savePromptHistory([]);
    setHistoryOpen(false);
    log("info", "已清空提示词历史");
  }

  useLayoutEffect(() => {
    if (!historyOpen) {
      setHistoryPanelStyle(null);
      return;
    }
    updateHistoryPanelPosition();
    function onReposition() {
      updateHistoryPanelPosition();
    }
    window.addEventListener("resize", onReposition);
    // capture scroll from nested containers too
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [historyOpen, mode]);

  useEffect(() => {
    if (!historyOpen) return;
    function onDoc(e: MouseEvent) {
      const target = e.target as Node;
      if (historyWrapRef.current?.contains(target)) return;
      if (historyPanelRef.current?.contains(target)) return;
      setHistoryOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setHistoryOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [historyOpen]);

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
        text: "请先配置创作 API Base URL 与 Key",
      });
      openConfigOrLogin();
      return;
    }
    const current = draft.promptText;
    if (!current.trim()) {
      setOptimizeNotice({ ok: false, text: "请先输入提示词" });
      return;
    }
    rememberPrompt(current);
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
      rememberPrompt(optimized);
      setOptimizeNotice({ ok: true, text: "已优化并覆盖输入框 · 可点「回退」恢复" });
      log("ok", "提示词优化完成", {
        model: ep.model,
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
    rememberPrompt(draft.promptText);
    setDraft({ promptText: "" });
    setPromptBeforeOptimize(null);
    setOptimizeNotice(null);
    log("info", "已清空提示词");
  }

  function clearReferenceImage() {
    referenceLoadIdRef.current += 1;
    setDraft({
      referenceImageUrl: undefined,
      referenceImageName: undefined,
      referenceImageWidth: undefined,
      referenceImageHeight: undefined,
      aspectRatio: draft.aspectRatio === SOURCE_ASPECT_RATIO ? settings.aspectRatio : draft.aspectRatio,
    });
    setReferenceError(null);
    if (referenceInputRef.current) referenceInputRef.current.value = "";
    if (referenceInputChatRef.current) referenceInputChatRef.current.value = "";
    log("info", "已清除参考图");
  }

  function readReferenceFile(file: File) {
    setReferenceError(null);
    if (!file.type.startsWith("image/")) {
      setReferenceError("请选择图片文件");
      return;
    }
    // 过大 data URL 会拖慢请求；提示但仍允许（上游可能拒绝）
    const maxBytes = 8 * 1024 * 1024;
    if (file.size > maxBytes) {
      setReferenceError("图片超过 8MB，建议压缩后再试");
      return;
    }
    const loadId = ++referenceLoadIdRef.current;
    const reader = new FileReader();
    reader.onload = () => {
      if (loadId !== referenceLoadIdRef.current) return;
      const result = typeof reader.result === "string" ? reader.result : "";
      if (!result.startsWith("data:image/")) {
        setReferenceError("无法读取图片");
        return;
      }
      measureReferenceImage(
        result,
        ({ width, height }) => {
          if (loadId !== referenceLoadIdRef.current) return;
          setDraft({
            referenceImageUrl: result,
            referenceImageName: file.name || "reference.png",
            referenceImageWidth: width,
            referenceImageHeight: height,
          });
          log("ok", "已加载参考图", {
            name: file.name,
            size: file.size,
            type: file.type,
            width,
            height,
          });
        },
        () => {
          if (loadId === referenceLoadIdRef.current) setReferenceError("无法读取图片尺寸");
        },
      );
    };
    reader.onerror = () => {
      if (loadId === referenceLoadIdRef.current) setReferenceError("读取图片失败");
    };
    reader.readAsDataURL(file);
  }

  function handleReferenceInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) readReferenceFile(file);
  }

  function useJobAsReference(job: StudioJob) {
    const src =
      (typeof job.imageUrl === "string" && job.imageUrl) ||
      displayUrl(job) ||
      job.openUrl;
    if (!src) {
      setReferenceError("该结果没有可用图片地址");
      return;
    }
    const loadId = ++referenceLoadIdRef.current;
    setReferenceError(null);
    measureReferenceImage(
      src,
      ({ width, height }) => {
        if (loadId !== referenceLoadIdRef.current) return;
        setDraft({
          referenceImageUrl: src,
          referenceImageName: `job-${job.id.slice(0, 8)}.jpg`,
          referenceImageWidth: width,
          referenceImageHeight: height,
        });
        log("ok", "已用结果图作为参考图", { jobId: job.id, width, height });
      },
      () => {
        if (loadId === referenceLoadIdRef.current) setReferenceError("无法读取该结果图的尺寸");
      },
    );
  }

  const referencePicker = (
    inputRef: React.RefObject<HTMLInputElement | null>,
    inputId: string,
    compact = false,
  ) => (
    <div className={`reference-picker ${compact ? "reference-picker-compact" : ""}`}>
      <div className="field reference-picker-field">
        <div className="label-row prompt-label-row">
          <label htmlFor={inputId}>参考图</label>
        </div>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept="image/*"
          hidden
          disabled={running || optimizeBusy}
          onChange={handleReferenceInputChange}
        />
        {draft.referenceImageUrl ? (
          <div className="reference-picker-preview">
            <img src={draft.referenceImageUrl} alt={draft.referenceImageName || "参考图"} />
            <div className="reference-picker-meta">
              <span className="reference-picker-name" title={draft.referenceImageName}>
                {draft.referenceImageName || "参考图已就绪"}
              </span>
              <span className="reference-picker-hint">
                {videoMode ? "首帧参考图 · /videos/generations" : "图 + 提示词 · /images/edits"}
              </span>
            </div>
            <div className="reference-picker-actions">
              <button
                type="button"
                className="hall-chip"
                disabled={running || optimizeBusy}
                onClick={() => inputRef.current?.click()}
              >
                更换
              </button>
              <button
                type="button"
                className="hall-chip"
                disabled={running || optimizeBusy}
                onClick={clearReferenceImage}
              >
                清除
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="reference-picker-drop"
            disabled={running || optimizeBusy}
            onClick={() => inputRef.current?.click()}
          >
            {referenceRequired ? "点击上传参考图（必填）" : "点击上传参考图（可选）"}
          </button>
        )}
        {referenceError ? (
          <div
            className="studio-feedback studio-feedback-warn"
            role="status"
            style={{ marginTop: 8, marginBottom: 0 }}
          >
            <span className="studio-feedback-dot warn" aria-hidden />
            <span className="studio-feedback-text">{referenceError}</span>
          </div>
        ) : null}
      </div>
    </div>
  );

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

      const isVideo = job.kind === "video";

      // 配置了 CF Worker 时：先上传到 Telegram 存图，再把稳定 URL 写入大厅
      let imageUrl = src;
      let mediaId: string | undefined;
      if (isMediaConfigured()) {
        log("info", "分享：上传到媒体 Worker（Telegram）…");
        const uploaded = await uploadMedia(src, {
          filename: `ciallo-${job.id.slice(0, 10)}.${isVideo ? "mp4" : "jpg"}`,
        });
        imageUrl = uploaded.url;
        mediaId = uploaded.mediaId;
        log("ok", "媒体已入库", { mediaId, url: imageUrl });
      } else {
        log("info", "未配置 Media Base，使用原图 URL 分享（Mock / 临时）");
      }

      await communityApi.createPost({
        imageUrl,
        kind: isVideo ? "video" : "image",
        mediaId,
        prompt: job.prompt,
        model: isVideo ? settings.videoModel : settings.model,
        aspectRatio: job.aspectRatio,
        resolution: job.resolution || (isVideo ? draft.videoResolution : draft.resolution),
        duration: isVideo ? job.duration : undefined,
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
    draft.resolution,
    draft.videoResolution,
    onNeedLogin,
    settings.model,
    settings.videoModel,
    shareStatus,
    sharedJobIds,
  ]);

  /** 配置提示仍放创作台；分享结果放到作品墙选择栏，避免挤变形 */
  const setupFeedback = !configured ? (
    <div className="studio-feedback studio-feedback-muted" role="status">
      <span className="studio-feedback-dot muted" aria-hidden />
      <span className="studio-feedback-text">
        {isLoggedIn
          ? "尚未配置 API Key · 请到「设置」填写接口与密钥"
          : "尚未配置 API Key · 请先登录，再到「设置」填写"}
      </span>
    </div>
  ) : null;

  const wallShareFeedback = (
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
              className={`studio-feedback studio-feedback-inline ${shareNotice.ok ? "studio-feedback-ok" : "studio-feedback-warn"}`}
              role="status"
            >
              <span className={`studio-feedback-dot ${shareNotice.ok ? "ok" : "warn"}`} aria-hidden />
              <span className="studio-feedback-text">{shareNotice.text}</span>
            </div>
          )
          : null
        : null}
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
      allowReference={showReferencePicker}
      onToggle={handleToggleSelected}
      onPreview={handlePreviewJob}
      onUseAsReference={useJobAsReference}
      onShare={handleShareToHall}
    />
  );

  const previewSrc = displayUrl(previewJob);
  const previewIsVideo = previewJob?.kind === "video";
  const previewMeta =
    measuredPreview && measuredPreview.jobId === previewJob?.id ? measuredPreview.meta : undefined;
  const previewAlreadyShared = previewJob ? sharedJobIds.has(previewJob.id) : false;
  const previewShareBusy = previewJob ? sharingId === previewJob.id : false;
  const previewShareDisabled =
    !previewJob || previewAlreadyShared || previewShareBusy || shareCooldownLocked;
  const previewShareLabel = previewAlreadyShared
    ? "已分享"
    : previewShareBusy
      ? "分享中…"
      : shareCooldownLocked
        ? "冷却中"
        : "分享到大厅";
  const previewShareTitle = previewAlreadyShared
    ? "该图已分享，不可重复分享"
    : shareCooldownLocked
      ? "分享冷却中"
      : "分享到大厅";
  const previewLightbox = previewJob && previewSrc ? (
    <div
      className="studio-lightbox-backdrop"
      role="presentation"
      onClick={closePreview}
    >
      {canPreviewPrev ? (
        <button
          type="button"
          className="studio-lightbox-nav studio-lightbox-nav-prev"
          aria-label="上一张"
          title="上一张（←）"
          onClick={(e) => {
            e.stopPropagation();
            stepPreview(-1);
          }}
        >
          <ChevronLeft size={28} strokeWidth={2.2} aria-hidden />
        </button>
      ) : null}
      {canPreviewNext ? (
        <button
          type="button"
          className="studio-lightbox-nav studio-lightbox-nav-next"
          aria-label="下一张"
          title="下一张（→）"
          onClick={(e) => {
            e.stopPropagation();
            stepPreview(1);
          }}
        >
          <ChevronRight size={28} strokeWidth={2.2} aria-hidden />
        </button>
      ) : null}
      <div
        className="studio-lightbox"
        role="dialog"
        aria-modal="true"
        aria-label="大图预览"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="studio-lightbox-media">
          {previewJob.kind === "video" ? (
            <video
              src={previewSrc}
              controls
              autoPlay
              loop
              playsInline
              aria-label={previewJob.prompt || "视频预览"}
              onLoadedMetadata={(e) => {
                const el = e.currentTarget;
                setMeasuredPreview({
                  jobId: previewJob.id,
                  meta: {
                    width: el.videoWidth,
                    height: el.videoHeight,
                    duration: Number.isFinite(el.duration) ? el.duration : previewJob.duration,
                  },
                });
              }}
            />
          ) : (
            <img
              src={previewSrc}
              alt={previewJob.prompt || "大图预览"}
              decoding="async"
              onLoad={(e) => {
                const el = e.currentTarget;
                setMeasuredPreview({
                  jobId: previewJob.id,
                  meta: { width: el.naturalWidth, height: el.naturalHeight },
                });
              }}
            />
          )}
        </div>
        <div className="studio-lightbox-bottom">
          <div className="studio-lightbox-meta" title={previewJob.prompt}>
            <strong>
              #{previewJob.variant}
              {previewIndex >= 0 ? ` · ${previewIndex + 1}/${previewableJobs.length}` : ""}
            </strong>
            <span className="studio-lightbox-prompt">{previewJob.prompt}</span>
            <MediaMetaSpecs meta={previewMeta} isVideo={previewIsVideo} />
          </div>
          <div className="studio-lightbox-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => openMediaInNewTab(previewSrc, previewJob.kind === "video")}
            >
              {previewJob.kind === "video" ? "打开视频" : "打开原图"}
            </button>
            {previewJob.kind === "video" ? null : (
              <button
                type="button"
                className={`btn btn-sm ${previewAlreadyShared ? "btn-shared" : "btn-primary"}`}
                disabled={previewShareDisabled}
                title={previewShareTitle}
                onClick={() => {
                  if (!previewAlreadyShared) void handleShareToHall(previewJob);
                }}
              >
                {previewShareLabel}
              </button>
            )}
            <button
              type="button"
              className="studio-lightbox-close"
              aria-label="关闭预览"
              title="关闭"
              onClick={closePreview}
            >
              ×
            </button>
          </div>
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
                  对话流 · {successOnly ? wallJobs.length : stats.total} 件
                </h2>
              </div>
              <div className="results-toolbar-actions">
                {queueToggleButton}
                <div className="studio-wall-stat-chips" aria-label="生成统计">
                  <span className="chip gallery-filter-chip studio-stat-chip" title="作品墙总数">
                    总数
                    <strong className="studio-stat-chip-count">{stats.total}</strong>
                  </span>
                  <span className="chip gallery-filter-chip studio-stat-chip" title="已完成张数">
                    完成
                    <strong className="studio-stat-chip-count">{stats.done}</strong>
                  </span>
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
                  disabled={generateLocked || safeJobs.length === 0}
                  onClick={handleClear}
                >
                  清空
                </button>
              </div>
            </div>
            {queueNoticeBanner}
            {!serverQueueOpen ? (
              <>
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
                  <div className="selection-bar-actions">
                    <div className="selection-share-slot" aria-live="polite">
                      {wallShareFeedback}
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
              </>
            ) : null}
          </div>

          <div className="studio-chat-stream">
            {serverQueueOpen ? (
              serverQueueDetail
            ) : safeJobs.length === 0 ? (
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
              <div className="label-row prompt-label-row prompt-label-row-actions-only">
                <div className="prompt-optimize-actions" role="toolbar" aria-label="提示词操作">
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
                  {promptHistoryMenu}
                  <button
                    type="button"
                    className="hall-chip prompt-optimize-btn"
                    disabled={!canOptimize}
                    onClick={() => void handleOptimizePrompt()}
                  >
                    <span className="prompt-action-label">{optimizeBusy ? "优化中" : "优化"}</span>
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
                aria-label="提示词"
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
                  {videoMode ? "总条数" : "总数"} <strong>{plannedJobs}</strong>
                </span>
                {showReferencePicker && draft.referenceImageUrl ? (
                  <span className="stat-pill">含参考图</span>
                ) : null}
              </div>
              <button
                type="button"
                className="hall-chip"
                onClick={() => setChatParamsOpen((v) => !v)}
                aria-expanded={chatParamsOpen}
              >
                {chatParamsOpen ? "收起参数" : "参数"}
              </button>
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={generateLocked || prompts.length === 0}
                  onClick={handleGenerate}
                >
                  {generateButtonLabel("发送")}
                </button>
                <button type="button" className="btn btn-secondary" disabled={!stopEnabled} onClick={onStop}>
                  停止
                </button>
              </div>
              <div className="studio-toolbar-switches">
                {genModeSwitch}
                {advancedSwitch}
              </div>
            </div>
            {chatParamsOpen ? (
              <div className="studio-chat-params">
                {showReferencePicker ? (
                  <>
                    {referencePicker(referenceInputChatRef, "reference-image-chat", true)}
                    <div className="studio-params-divider" role="separator" />
                  </>
                ) : null}
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
                        {concurrencyOptions.map((n) => (
                          <button
                            key={n}
                            type="button"
                            className={`chip ${draft.concurrency === n ? "active" : ""}`}
                            onClick={() => setDraft({ concurrency: n })}
                            title={n > 2 ? `用户组并发上限 ${concurrencyCap}` : undefined}
                          >
                            {n}
                          </button>
                        ))}
                      </div>
                    </div>
                    {/* 对话模式：并发与分辨率之间保留竖线；控制台不加 */}
                    <div className="studio-params-vsep" role="separator" aria-orientation="vertical" />
                    {resolutionField}
                    {videoDurationField}
                  </div>
                  <div className="studio-params-divider" role="separator" />
                  <div className="studio-params-row studio-params-row-aspect">
                    {aspectRatioField}
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
        <div className="results-toolbar studio-console-head">
          <div>
            <div className="panel-kicker">Console</div>
            <h2 className="panel-title studio-wall-title">灵感创作台</h2>
          </div>
        </div>

        {setupFeedback}

        <div className="field">
          <div className="label-row prompt-label-row prompt-label-row-actions-only">
            <div className="prompt-optimize-actions" role="toolbar" aria-label="提示词操作">
              <div className="segmented prompt-mode-segmented" role="group" aria-label="提示词模式">
                <button
                  type="button"
                  className={`chip ${draft.promptMode !== "block" ? "active" : ""}`}
                  disabled={optimizeBusy || running}
                  title="每行一条 prompt，分别创作"
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
              {promptHistoryMenu}
              <button
                type="button"
                className="hall-chip prompt-optimize-btn"
                disabled={!canOptimize}
                title={
                  !optimizeEndpoint.model
                    ? "请先在设置页填写「提示词优化模型」"
                    : !optimizeEndpoint.apiKey || !optimizeEndpoint.baseUrl
                      ? "请先配置创作 API"
                      : !draft.promptText.trim()
                        ? "请先输入提示词"
                        : "调用 chat 模型优化当前提示词"
                }
                onClick={() => void handleOptimizePrompt()}
              >
                <span className="prompt-action-label">{optimizeBusy ? "优化中" : "优化"}</span>
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
            aria-label="提示词"
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
            <span className="stat-pill" title="生成数量（variants）">
              数量 <strong>{draft.variants}</strong>
            </span>
            <span className="stat-pill" title="同时请求数，也会乘进总数">
              并发 <strong>{draft.concurrency}</strong>
            </span>
            {showReferencePicker && draft.referenceImageUrl ? (
              <span className="stat-pill" title="本次生成将附带参考图">
                含参考图
              </span>
            ) : null}
            <span
              className="stat-pill"
              title={
                draft.promptMode === "block"
                  ? `总数 = 1 × 创作数量 × 并发数`
                  : `总数 = Prompt 条数 × 创作数量 × 并发数`
              }
            >
              {videoMode ? "总条数" : "总数"} <strong>{plannedJobs}</strong>
            </span>
          </div>
        </div>

        <div className="studio-options">
          {/* 操作 + 参数 + 参考图合并为一张卡片 */}
          <div className="option-block option-block-studio">
            <div className="studio-toolbar">
              <div className="btn-row studio-toolbar-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={generateLocked || prompts.length === 0}
                  onClick={handleGenerate}
                >
                  {generateButtonLabel("开始生成")}
                </button>
                <button type="button" className="btn btn-secondary" disabled={!stopEnabled} onClick={onStop}>
                  停止
                </button>
              </div>
              <div className="studio-toolbar-switches">
                {genModeSwitch}
                {advancedSwitch}
              </div>
            </div>

            {queueNoticeBanner}

            <div className="studio-params-divider" role="separator" />

            {showReferencePicker ? (
              <>
                {referencePicker(referenceInputRef, "reference-image-console")}
                <div className="studio-params-divider" role="separator" />
              </>
            ) : null}

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
                    {concurrencyOptions.map((n) => (
                      <button
                        key={n}
                        type="button"
                        className={`chip ${draft.concurrency === n ? "active" : ""}`}
                        onClick={() => setDraft({ concurrency: n })}
                        title={n > 2 ? `用户组并发上限 ${concurrencyCap}` : undefined}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
                {resolutionField}
                {videoDurationField}
              </div>
              <div className="studio-params-divider" role="separator" />
              <div className="studio-params-row studio-params-row-aspect">
                {aspectRatioField}
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
              作品墙 · {successOnly ? wallJobs.length : stats.total} 件
              {successOnly && stats.total > wallJobs.length ? (
                <span className="studio-wall-filter-hint">（仅成功）</span>
              ) : null}
            </h2>
          </div>
          <div className="results-toolbar-actions">
            {/* 队列在总数左侧；KPI 始终占位 */}
            {queueToggleButton}
            <div className="studio-wall-stat-chips" aria-label="生成统计">
              <span className="chip gallery-filter-chip studio-stat-chip" title="作品墙总数">
                总数
                <strong className="studio-stat-chip-count">{stats.total}</strong>
              </span>
              <span className="chip gallery-filter-chip studio-stat-chip" title="已完成张数">
                完成
                <strong className="studio-stat-chip-count">{stats.done}</strong>
              </span>
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
              disabled={generateLocked || safeJobs.length === 0}
              onClick={handleClear}
            >
              清空
            </button>
          </div>
        </div>

        {queueNoticeBanner}

        {serverQueueOpen ? (
          serverQueueDetail
        ) : (
          <>
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
              <div className="selection-bar-actions">
                <div className="selection-share-slot" aria-live="polite">
                  {wallShareFeedback}
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
          </>
        )}
      </section>
      {previewLightbox}
    </div>
  );
}
