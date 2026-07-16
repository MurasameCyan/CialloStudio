import { ApiError } from "@/lib/api";
import { log } from "@/lib/logger";
import { ASPECT_RATIOS, RESOLUTIONS, type StudioSettings } from "@/lib/settings";
import {
  CONCURRENCY_OPTIONS,
  VARIANT_OPTIONS,
  displayUrl,
  type StudioDraft,
  type StudioJob,
} from "@/lib/studioQueue";

type Stats = { total: number; done: number; failed: number; active: number };

type Props = {
  settings: StudioSettings;
  onOpenSettings: () => void;
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
  const configured = Boolean(settings.apiKey.trim());

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
              每条 <strong>{draft.variants}</strong> 张
            </span>
            <span className="stat-pill">
              并发 <strong>{draft.concurrency}</strong>
            </span>
            <span className="stat-pill">
              子任务 <strong>{plannedJobs}</strong>
            </span>
          </div>
        </div>

        <div className="studio-options">
          <div className="option-block">
            <div className="field">
              <label>每条张数</label>
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
          </div>

          <div className="option-block">
            <div className="field">
              <label>并发数</label>
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
              <div className="field-hint">同时最多跑几个请求。例如 4 张 × 并发 3 = 先跑 3 张，完成后再补第 4 张。</div>
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
            <button type="button" className="btn btn-danger" disabled={running || jobs.length === 0} onClick={onClear}>
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
            {running ? `并行中 · 并发 ${draft.concurrency}` : stats.total ? "空闲" : "等待开始"}
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
                <div className="kpi-label">子任务</div>
                <div className="kpi-value">{stats.total}</div>
              </div>
              <div className="kpi">
                <div className="kpi-label">完成</div>
                <div className="kpi-value">{stats.done}</div>
              </div>
              <div className="kpi">
                <div className="kpi-label">失败 / 进行中</div>
                <div className="kpi-value">
                  {stats.failed}/{stats.active}
                </div>
              </div>
            </div>

            <div className="progress-track" aria-hidden>
              <div className="progress-fill" style={{ width: `${progress}%` }} />
            </div>

            <div className="gallery">
              {jobs.map((job) => {
                const src = displayUrl(job);
                return (
                  <article key={job.id} className="card">
                    <span
                      className={`badge ${
                        job.status === "done" ? "done" : job.status === "failed" ? "failed" : "running"
                      }`}
                    >
                      #{job.variant}/{job.variants}
                    </span>
                    <div className="card-media">
                      {job.status === "done" && src ? (
                        <>
                          <img src={src} alt={`${job.prompt} #${job.variant}`} loading="lazy" />
                          <div className="card-overlay">
                            <a href={job.openUrl || src} target="_blank" rel="noreferrer">
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
