import { useEffect, useMemo, useState } from "react";
import { ApiError } from "@/lib/api";
import { downloadJobs } from "@/lib/download";
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
  const configured = Boolean(settings.apiKey.trim());
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [downloading, setDownloading] = useState(false);

  const downloadableJobs = useMemo(
    () => jobs.filter((job) => job.status === "done" && Boolean(displayUrl(job) || job.openUrl)),
    [jobs],
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

  return (
    <div className="page grid-2">
      <section className="panel">
        <div className="panel-head">
          <div>
            <div className="panel-kicker">Create</div>
            <h2 className="panel-title">灵感工作台</h2>
            <p className="panel-desc">每行一个提示词。张数 × 并发池同时出图，切到管理页也不会丢队列和结果。</p>
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
            <span className="stat-pill">
              总张数 <strong>{plannedJobs}</strong>
            </span>
            <span className="stat-pill">
              同时请求 <strong>{draft.concurrency}</strong>
            </span>
            {running ? (
              <span className="stat-pill">
                在飞 <strong>{inFlight}</strong>
              </span>
            ) : null}
          </div>
        </div>

        <div className="studio-options">
          <div className="option-block">
            <div className="field">
              <label>生成张数（每条 prompt 出几张）</label>
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
              <div className="field-hint">这是总产出数量。选 4 = 最终生成 4 张图。</div>
            </div>
          </div>

          <div className="option-block">
            <div className="field">
              <label>同时请求数（并发）</label>
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
              <div className="field-hint">
                不是张数倍数。例：生成 4 张 + 同时 2 路 = 先跑 2 张，完成后再跑剩下 2 张。生成中看「在飞」。
              </div>
            </div>
          </div>

          <div className="option-block">
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

          <div className="option-block">
            <div className="field">
              <label>分辨率</label>
              <div className="segmented">
                {RESOLUTIONS.map((item) => (
                  <button
                    key={item}
                    type="button"
                    className={`chip ${draft.resolution === item ? "active" : ""}`}
                    onClick={() => setDraft({ resolution: item })}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="action-bar">
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
            <button type="button" className="btn btn-danger" disabled={running || jobs.length === 0} onClick={handleClear}>
              清空
            </button>
          </div>
          <button type="button" className="btn btn-ghost" onClick={onOpenSettings}>
            模型 {settings.model || "未选择"} →
          </button>
        </div>
      </section>

      <section className="panel results-panel">
        <div className="results-toolbar">
          <div>
            <div className="panel-kicker">Gallery</div>
            <h2 className="panel-title">结果墙</h2>
          </div>
          <div className="connection-chip">
            <span className={`live-dot ${running ? "" : "off"}`} />
            {running
              ? `在飞 ${inFlight}/${draft.concurrency} · 排队 ${stats.queued}`
              : stats.total
                ? "空闲"
                : "等待开始"}
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
            <div className="kpi-row">
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
