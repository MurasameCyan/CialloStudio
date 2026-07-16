import { useMemo, useRef, useState } from "react";
import { ApiError, generateImage, rewriteMediaUrl, runPool } from "@/lib/api";
import { log } from "@/lib/logger";
import { ASPECT_RATIOS, RESOLUTIONS, type StudioSettings } from "@/lib/settings";

type JobStatus = "queued" | "running" | "done" | "failed";

type Job = {
  id: string;
  batchId: string;
  variant: number;
  variants: number;
  prompt: string;
  status: JobStatus;
  imageUrl?: string;
  openUrl?: string;
  error?: string;
  createdAt: number;
  finishedAt?: number;
};

type Props = {
  settings: StudioSettings;
  onOpenSettings: () => void;
};

const VARIANT_OPTIONS = [1, 2, 3, 4, 6, 8] as const;

function splitPrompts(raw: string): string[] {
  return raw
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function uid(prefix = ""): string {
  return `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clampVariants(value: number): number {
  if (!Number.isFinite(value)) return 4;
  return Math.min(8, Math.max(1, Math.round(value)));
}

function expandJobs(prompts: string[], variants: number): Job[] {
  const count = clampVariants(variants);
  const now = Date.now();
  const jobs: Job[] = [];
  for (const prompt of prompts) {
    const batchId = uid("batch-");
    for (let variant = 1; variant <= count; variant += 1) {
      jobs.push({
        id: uid("job-"),
        batchId,
        variant,
        variants: count,
        prompt,
        status: "queued",
        createdAt: now,
      });
    }
  }
  return jobs;
}

export function StudioPage({ settings, onOpenSettings }: Props) {
  const [promptText, setPromptText] = useState("a cute orange cat sitting on a windowsill, soft daylight, minimal");
  const [aspectRatio, setAspectRatio] = useState(settings.aspectRatio);
  const [resolution, setResolution] = useState(settings.resolution);
  const [variants, setVariants] = useState(4);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const prompts = useMemo(() => splitPrompts(promptText), [promptText]);
  const plannedJobs = prompts.length * variants;
  const stats = useMemo(() => {
    const total = jobs.length;
    const done = jobs.filter((j) => j.status === "done").length;
    const failed = jobs.filter((j) => j.status === "failed").length;
    const active = jobs.filter((j) => j.status === "running" || j.status === "queued").length;
    return { total, done, failed, active };
  }, [jobs]);

  const progress = stats.total === 0 ? 0 : Math.round(((stats.done + stats.failed) / stats.total) * 100);
  const configured = Boolean(settings.apiKey.trim());

  async function handleGenerate() {
    if (!configured) {
      onOpenSettings();
      return;
    }
    if (prompts.length === 0 || running) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);

    const batch = expandJobs(prompts, variants);
    setJobs((prev) => [...batch, ...prev]);
    log("info", `并发生图开始：${prompts.length} 条 prompt × ${variants} 张 = ${batch.length} 子任务`, {
      model: settings.model,
      baseUrl: settings.baseUrl,
      concurrency: settings.concurrency,
      aspectRatio,
      resolution,
      mode: "fan-out-subagents",
    });

    try {
      await runPool(
        batch,
        settings.concurrency,
        async (job) => {
          setJobs((prev) =>
            prev.map((item) => (item.id === job.id ? { ...item, status: "running" } : item)),
          );
          log("info", `子任务 ${job.variant}/${job.variants} 开始 ${job.id}`, {
            batchId: job.batchId,
            prompt: job.prompt,
          });
          const images = await generateImage({
            baseUrl: settings.baseUrl,
            apiKey: settings.apiKey,
            model: settings.model,
            prompt: job.prompt,
            n: 1,
            aspectRatio,
            resolution,
            signal: controller.signal,
          });
          const imageUrl = images[0]?.url;
          if (!imageUrl) {
            throw new ApiError(200, "未返回图片 URL", "invalid_response");
          }
          const openUrl =
            images[0]?.openUrl ||
            (imageUrl.startsWith("blob:") || imageUrl.startsWith("data:")
              ? undefined
              : rewriteMediaUrl(imageUrl, settings.baseUrl));
          log("ok", `子任务 ${job.variant}/${job.variants} 完成 ${job.id}`, { imageUrl, openUrl });
          return { imageUrl, openUrl };
        },
        (index, result) => {
          const job = batch[index];
          if (result.status === "fulfilled") {
            setJobs((prev) =>
              prev.map((item) =>
                item.id === job.id
                  ? {
                      ...item,
                      status: "done",
                      imageUrl: result.value.imageUrl,
                      openUrl: result.value.openUrl,
                      finishedAt: Date.now(),
                    }
                  : item,
              ),
            );
          } else {
            const reason = result.reason;
            let message =
              reason instanceof ApiError
                ? reason.message
                : reason instanceof Error
                  ? reason.message
                  : "生成失败";
            if (message.length > 280) {
              message = `${message.slice(0, 280)}…（完整内容见管理页运行日志）`;
            }
            log(
              "error",
              `子任务 ${job.variant}/${job.variants} 失败 ${job.id}`,
              reason instanceof Error ? reason.message : message,
            );
            setJobs((prev) =>
              prev.map((item) =>
                item.id === job.id
                  ? {
                      ...item,
                      status: "failed",
                      error: message,
                      finishedAt: Date.now(),
                    }
                  : item,
              ),
            );
          }
        },
      );
      log("ok", "并发生图结束");
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  function handleStop() {
    abortRef.current?.abort();
    log("warn", "用户停止：已 abort 进行中的子任务");
  }

  function handleClear() {
    if (running) return;
    setJobs([]);
  }

  return (
    <div className="page grid-2">
      <section className="panel">
        <div className="panel-head">
          <div>
            <div className="panel-kicker">Create</div>
            <h2 className="panel-title">灵感工作台</h2>
            <p className="panel-desc">
              每行一个提示词。设置张数后会拆成并发子任务，完成后逐张出现。
            </p>
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
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
            placeholder={"每行一个 prompt\n例如：cyberpunk city at night\na watercolor fox"}
          />
          <div className="composer-stats">
            <span className="stat-pill">
              Prompt <strong>{prompts.length}</strong>
            </span>
            <span className="stat-pill">
              每条 <strong>{variants}</strong> 张
            </span>
            <span className="stat-pill">
              子任务 <strong>{plannedJobs}</strong>
            </span>
            <span className="stat-pill">
              并发槽 <strong>{settings.concurrency}</strong>
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
                    className={`chip ${variants === n ? "active" : ""}`}
                    onClick={() => setVariants(n)}
                  >
                    {n}
                  </button>
                ))}
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
                    className={`chip ${aspectRatio === ratio ? "active" : ""}`}
                    onClick={() => setAspectRatio(ratio)}
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
                    className={`chip ${resolution === item ? "active" : ""}`}
                    onClick={() => setResolution(item)}
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
            <button type="button" className="btn btn-secondary" disabled={!running} onClick={handleStop}>
              停止
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={running || jobs.length === 0}
              onClick={handleClear}
            >
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
            {running ? "并行中" : stats.total ? "空闲" : "等待开始"}
          </div>
        </div>

        {jobs.length === 0 ? (
          <div className="empty empty-compact">
            <div className="empty-icon" aria-hidden />
            <div>
              <span className="empty-title">还没有画面</span>
              <p className="empty-text">写好提示词后点「开始生成」，结果会出现在这里。</p>
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
              {jobs.map((job) => (
                <article key={job.id} className="card">
                  <span
                    className={`badge ${
                      job.status === "done" ? "done" : job.status === "failed" ? "failed" : "running"
                    }`}
                  >
                    #{job.variant}/{job.variants}
                  </span>
                  <div className="card-media">
                    {job.status === "done" && job.imageUrl ? (
                      <>
                        <img src={job.imageUrl} alt={`${job.prompt} #${job.variant}`} loading="lazy" />
                        <div className="card-overlay">
                          <a href={job.openUrl || job.imageUrl} target="_blank" rel="noreferrer">
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
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
