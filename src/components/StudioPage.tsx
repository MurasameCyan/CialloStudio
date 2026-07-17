import { useEffect, useMemo, useState } from "react";
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

type Stats = { total: number; done: number; failed: number; active: number; running: number; queued: number };

type Props = {
  settings: StudioSettings;
  onOpenSettings: () => void;
  /** 未登录时跳转账号页 */
  onNeedLogin?: () => void;
  /** 是否已登录社区账号（未配置 Key 时决定去登录还是去设置） */
  isLoggedIn?: boolean;
  /** 分享成功后可选跳转大厅 */
  onSharedToHall?: () => void;
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
  settings,
  onOpenSettings,
  onNeedLogin,
  isLoggedIn = false,
  onSharedToHall,
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
  const [shareStatus, setShareStatus] = useState<ShareStatus | null>(null);
  /** 仅在用户点过「分享到大厅」后展示冷却/结果条，默认不占位 */
  const [shareUiRevealed, setShareUiRevealed] = useState(false);
  const [shareNotice, setShareNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [optimizeBusy, setOptimizeBusy] = useState(false);
  /** 优化前快照，供「回退」一次 */
  const [promptBeforeOptimize, setPromptBeforeOptimize] = useState<string | null>(null);
  const [optimizeNotice, setOptimizeNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const optimizeEndpoint = useMemo(() => resolvePromptOptimizeEndpoint(settings), [settings]);
  const canOptimize = Boolean(
    optimizeEndpoint.model &&
      optimizeEndpoint.baseUrl &&
      optimizeEndpoint.apiKey &&
      draft.promptText.trim() &&
      !optimizeBusy &&
      !running,
  );

  const shareRemainSec = useMemo(() => {
    if (!shareStatus) return 0;
    return computeShareRemainSec(shareStatus.cooldownSec, shareStatus.lastShareAt, nowMs);
  }, [shareStatus, nowMs]);

  const shareCooldownLocked = shareRemainSec > 0;

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
    // 仅在已展示且仍在冷却时跑秒表，避免空闲时多余 tick
    if (!shareUiRevealed || !shareStatus || shareStatus.cooldownSec <= 0 || !shareStatus.lastShareAt) {
      return;
    }
    if (shareRemainSec <= 0) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [shareUiRevealed, shareStatus, shareRemainSec]);

  useEffect(() => {
    if (!shareNotice) return;
    // 冷却中的提示跟倒计时走，不自动关掉
    if (!shareNotice.ok && /冷却/.test(shareNotice.text)) return;
    const id = window.setTimeout(() => setShareNotice(null), shareNotice.ok ? 2800 : 6000);
    return () => window.clearTimeout(id);
  }, [shareNotice]);

  // 冷却结束：收起冷却条，回到默认不显示
  useEffect(() => {
    if (shareUiRevealed && shareStatus && shareStatus.cooldownSec > 0 && shareRemainSec <= 0) {
      setShareUiRevealed(false);
      setShareNotice((prev) => (prev && !prev.ok && /冷却/.test(prev.text) ? null : prev));
    }
  }, [shareUiRevealed, shareStatus, shareRemainSec]);

  const safeJobs = Array.isArray(jobs) ? jobs : [];
  const downloadableJobs = useMemo(
    () =>
      safeJobs.filter(
        (job) => job && job.status === "done" && Boolean(displayUrl(job) || job.openUrl),
      ),
    [safeJobs],
  );
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

  function toggleOne(id: string) {
    if (!downloadableIds.has(id)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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
      });
      setPromptBeforeOptimize(current);
      setDraft({ promptText: optimized });
      setOptimizeNotice({ ok: true, text: "已优化并覆盖输入框 · 可点「回退」恢复" });
      log("ok", "提示词优化完成", {
        model: ep.model,
        customUpstream: ep.usingCustomUpstream,
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

  function handleClear() {
    clearSelection();
    onClear();
  }

  async function handleShareToHall(job: StudioJob) {
    const src = displayUrl(job) || job.openUrl;
    if (!src || job.status !== "done") return;
    setShareUiRevealed(true);
    if (shareCooldownLocked) {
      const text = `分享冷却中：还剩 ${shareRemainSec} 秒`;
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
      let nextCooldown = shareStatus?.cooldownSec;
      try {
        const st = await communityApi.getShareStatus();
        setShareStatus(st);
        setNowMs(Date.now());
        nextCooldown = st.cooldownSec;
      } catch {
        // ignore refresh errors
      }
      // 有冷却：直接展示倒计时；无冷却：仅短暂成功提示
      if (nextCooldown && nextCooldown > 0) {
        setShareNotice({
          ok: false,
          text: `分享冷却中：还剩 ${nextCooldown} 秒`,
        });
      } else {
        setShareNotice({ ok: true, text: "已分享到大厅" });
        setShareUiRevealed(false);
      }
      // 稍后再跳转大厅，让工作台先显示反馈
      if (onSharedToHall) {
        window.setTimeout(() => onSharedToHall(), nextCooldown && nextCooldown > 0 ? 1600 : 900);
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
          setNowMs(Date.now());
          setShareNotice({
            ok: false,
            text: `分享冷却中：还剩 ${computeShareRemainSec(st.cooldownSec, st.lastShareAt)} 秒`,
          });
        } catch {
          // ignore
        }
      }
    } finally {
      setSharingId(null);
    }
  }

  return (
    <div className="page grid-2">
      <section className="panel">
        <div className="panel-head">
          <div>
            <div className="panel-kicker">Create</div>
            <h2 className="panel-title">灵感工作台</h2>
          </div>
        </div>

        {/* 轻量反馈：玻璃胶囊条，与 connection-chip / stat-pill 同系 */}
        {shareUiRevealed && shareCooldownLocked ? (
          <div className="studio-feedback studio-feedback-warn" role="status">
            <span className="studio-feedback-dot warn" aria-hidden />
            <span className="studio-feedback-text">
              分享冷却中 · 还剩 <strong>{shareRemainSec}</strong> 秒
            </span>
          </div>
        ) : shareNotice ? (
          <div
            className={`studio-feedback ${shareNotice.ok ? "studio-feedback-ok" : "studio-feedback-warn"}`}
            role="status"
          >
            <span className={`studio-feedback-dot ${shareNotice.ok ? "ok" : "warn"}`} aria-hidden />
            <span className="studio-feedback-text">{shareNotice.text}</span>
          </div>
        ) : null}

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

        <div className="field">
          <div className="label-row prompt-label-row">
            <label htmlFor="prompts">Prompt</label>
            <div className="prompt-optimize-actions">
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
            </div>
          </div>
          <textarea
            id="prompts"
            className="textarea"
            value={draft.promptText}
            onChange={(e) => setDraft({ promptText: e.target.value })}
            placeholder={"每行一个 prompt\n例如：cyberpunk city at night\na watercolor fox"}
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
            <span className="stat-pill">
              Prompt <strong>{prompts.length}</strong>
            </span>
            <span className="stat-pill" title="生图数量（variants）">
              生图 <strong>{draft.variants}</strong>
            </span>
            <span className="stat-pill" title="同时请求数，也会乘进总张数">
              并发 <strong>{draft.concurrency}</strong>
            </span>
            <span
              className="stat-pill"
              title="总张数 = Prompt 条数 × 生图数量 × 并发数"
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

      <section className="panel results-panel">
        <div className="results-toolbar">
          <div>
            <div className="panel-kicker">Gallery</div>
            <h2 className="panel-title">图片墙 · {stats.total} 张</h2>
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
        ) : (
          <div className="gallery">
            {safeJobs.map((job) => {
              const src = displayUrl(job);
              const canSelect = job.status === "done" && Boolean(src || job.openUrl);
              const isSelected = selected.has(job.id);
              return (
                <article key={job.id} className={`card ${isSelected ? "selected" : ""}`}>
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
                        checked={isSelected}
                        disabled={downloading}
                        onChange={() => toggleOne(job.id)}
                      />
                    </label>
                  ) : null}

                  <div
                    className="card-media"
                    onClick={() => {
                      if (canSelect) toggleOne(job.id);
                    }}
                  >
                    {job.status === "done" && src ? (
                      <>
                        <img src={src} alt={`${job.prompt} #${job.variant}`} loading="lazy" />
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
                            className="btn btn-primary btn-sm"
                            disabled={sharingId === job.id || shareCooldownLocked}
                            title={
                              shareCooldownLocked
                                ? `冷却中，${shareRemainSec} 秒后可分享`
                                : "分享到大厅"
                            }
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleShareToHall(job);
                            }}
                          >
                            {sharingId === job.id
                              ? "分享中…"
                              : shareCooldownLocked
                                ? `冷却 ${shareRemainSec}s`
                                : "分享到大厅"}
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
            })}
          </div>
        )}
      </section>
    </div>
  );
}
