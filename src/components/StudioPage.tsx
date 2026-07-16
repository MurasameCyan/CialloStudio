import { useEffect, useMemo, useState } from "react";
import { ApiError } from "@/lib/api";
import { communityApi } from "@/lib/community/client";
import { downloadJobs } from "@/lib/download";
import { getImageModelCapability } from "@/lib/imageModels";
import { log } from "@/lib/logger";
import { ASPECT_RATIOS, RESOLUTIONS, type StudioSettings } from "@/lib/settings";
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
  /** 分享成功后可选跳转大厅 */
  onSharedToHall?: () => void;
  draft: StudioDraft;
  setDraft: (patch: Partial<StudioDraft>) => void;
  jobs: StudioJob[];
  running: boolean;
  inFlight: number;
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
  onSharedToHall,
  draft,
  setDraft,
  jobs,
  running,
  inFlight,
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

  const downloadableJobs = useMemo(
    () => jobs.filter((job) => job.status === "done" && Boolean(displayUrl(job) || job.openUrl)),
    [jobs],
  );
  const downloadableIds = useMemo(() => new Set(downloadableJobs.map((j) => j.id)), [downloadableJobs]);
  /** 总张数 = Prompt × 生图数量 × 并发，故 worker 上限通常等于设定并发 */
  const effectiveConcurrency = useMemo(() => {
    if (plannedJobs <= 0) return 0;
    return Math.max(1, Math.min(draft.concurrency, plannedJobs));
  }, [draft.concurrency, plannedJobs]);

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

  async function handleGenerate() {
    if (!configured) {
      onOpenSettings();
      return;
    }
    try {
      await onStart();
    } catch (error) {
      const message = error instanceof ApiError ? error.message : error instanceof Error ? error.message : "启动失败";
      log("error", "启动生成失败", message);
    }
  }

  function handleClear() {
    clearSelection();
    onClear();
  }

  async function handleShareToHall(job: StudioJob) {
    const src = displayUrl(job) || job.openUrl;
    if (!src || job.status !== "done") return;
    setSharingId(job.id);
    try {
      const me = await communityApi.me();
      if (!me) {
        log("warn", "分享大厅需要先登录社区账号");
        onNeedLogin?.();
        return;
      }
      await communityApi.createPost({
        imageUrl: src,
        prompt: job.prompt,
        model: settings.model,
        aspectRatio: job.aspectRatio || draft.aspectRatio,
        resolution: job.resolution || draft.resolution,
      });
      log("ok", "已分享到大厅");
      onSharedToHall?.();
    } catch (error) {
      log("error", "分享失败", error instanceof Error ? error.message : String(error));
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

        {!configured ? (
          <div className="status err" style={{ marginBottom: 14 }}>
            还没有 API Key。请先到「管理」页填写接口与密钥。
          </div>
        ) : null}

        <div className="field">
          <label htmlFor="prompts">Prompt</label>
          <textarea
            id="prompts"
            className="textarea"
            value={draft.promptText}
            onChange={(e) => setDraft({ promptText: e.target.value })}
            placeholder={"每行一个 prompt\n例如：cyberpunk city at night\na watercolor fox"}
          />
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
            {running ? (
              <span className="stat-pill">
                在飞 <strong>{inFlight}</strong>/{effectiveConcurrency}
              </span>
            ) : null}
          </div>
        </div>

        <div className="studio-options">
          <div className="option-block option-block-actions">
            <div className="action-bar action-bar-compact">
              <div className="btn-row">
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
              <button type="button" className="btn btn-ghost" onClick={onOpenSettings}>
                模型 {settings.model || "未选择"} →
              </button>
            </div>
            <label className="append-toggle" title="关闭后，每次生成只保留本次结果">
              <input
                type="checkbox"
                checked={Boolean(draft.appendResults)}
                disabled={running}
                onChange={(e) => setDraft({ appendResults: e.target.checked })}
              />
              <span>追加到图片墙</span>
            </label>
          </div>

          <div className="option-block option-block-params">
            <div className="studio-params-grid">
              <div className="studio-params-row">
                <div className="field">
                  <label>生图数量</label>
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
                  <label>并发数（同时请求）</label>
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
              </div>
              <div className="studio-params-row">
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
            {jobs.length > 0 ? (
              <div className="kpi-row kpi-row-inline" aria-label="生成统计">
                <div className="kpi">
                  <div className="kpi-label">总数</div>
                  <div className="kpi-value">{stats.total}</div>
                </div>
                <div className="kpi">
                  <div className="kpi-label">完成</div>
                  <div className="kpi-value">{stats.done}</div>
                </div>
                <div className="kpi">
                  <div className="kpi-label">在飞 / 排队</div>
                  <div className="kpi-value">
                    {running ? inFlight : stats.running}/{stats.queued}
                  </div>
                </div>
              </div>
            ) : null}
            <div className="connection-chip">
              <span className={`live-dot ${running ? "" : "off"}`} />
              {running
                ? `在飞 ${inFlight}/${effectiveConcurrency} · 排队 ${stats.queued}`
                : stats.total
                  ? "空闲"
                  : "等待开始"}
            </div>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={running || jobs.length === 0}
              onClick={handleClear}
            >
              清空
            </button>
          </div>
        </div>

        {jobs.length === 0 ? (
          <div className="empty empty-compact">
            <div className="empty-icon" aria-hidden />
            <div>
              <span className="empty-title">还没有画面</span>
              <p className="empty-text">写好提示词后点「开始生成」。结果与队列会自动保留。</p>
            </div>
          </div>
        ) : (
          <>
            <div className="progress-track" aria-hidden>
              <div className="progress-fill" style={{ width: `${progress}%` }} />
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

            <div className="gallery">
              {jobs.map((job) => {
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
                              disabled={sharingId === job.id}
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleShareToHall(job);
                              }}
                            >
                              {sharingId === job.id ? "分享中…" : "分享到大厅"}
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
          </>
        )}
      </section>
    </div>
  );
}
