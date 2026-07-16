import { useMemo, useRef, useState } from "react";
import { ApiError, generateImage, rewriteMediaUrl, runPool } from "@/lib/api";
import { log } from "@/lib/logger";
import { ASPECT_RATIOS, RESOLUTIONS, type StudioSettings } from "@/lib/settings";

type JobStatus = "queued" | "running" | "done" | "failed";

type Job = {
  id: string;
  /** 同一条 prompt 拆出的并发组 */
  batchId: string;
  /** 在组内序号，从 1 开始 */
  variant: number;
  /** 该 prompt 共拆出几张 */
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

/**
 * 把「提示词列表 × 每条张数」展开成并行子任务（类似 sub-agent）。
 * 每个子任务独立请求一次 /images/generations，由全局并发池调度。
 */
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
    const batches = new Set(jobs.map((j) => j.batchId)).size;
    return { total, done, failed, active, batches };
  }, [jobs]);

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
          // 每个子任务独立 n=1，真正并行；比单请求 n=N 更稳，也更像 sub-agent
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
              message = `${message.slice(0, 280)}…（完整内容见底部运行日志）`;
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
      log("ok", "并发生图结束", {
        total: batch.length,
        done: batch.length, // 结束态在 UI 统计
      });
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
        <h2 className="panel-title">生图</h2>
        <p className="panel-desc">
          每行一个 prompt。设置「每条张数」后，会拆成多个并发子任务（类似 sub-agent），由全局并发池调度。
          当前模型：
          <span className="mono"> {settings.model || "未选择"}</span>
        </p>

        {!configured ? (
          <div className="status err" style={{ marginBottom: 14 }}>
            还没有 API Key。请先到「管理」页填写接口与密钥。
          </div>
        ) : null}

        <div className="field">
          <label htmlFor="prompts">Prompt 列表</label>
          <textarea
            id="prompts"
            className="textarea"
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
            placeholder={"每行一个 prompt\n例如：cyberpunk city at night\na watercolor fox"}
          />
          <div className="field-hint">
            {prompts.length} 条 prompt × {variants} 张 = <strong>{plannedJobs}</strong> 个子任务 · 全局并发槽{" "}
            {settings.concurrency}
          </div>
        </div>

        <div className="field">
          <label>每条生成张数（并发 fan-out）</label>
          <div className="chip-row">
            {VARIANT_OPTIONS.map((n) => (
              <button
                key={n}
                type="button"
                className={`chip ${variants === n ? "active" : ""}`}
                onClick={() => setVariants(n)}
              >
                {n} 张
              </button>
            ))}
          </div>
          <div className="field-hint">
            同一提示词会同时派出 {variants} 个独立请求；失败互不影响，完成一张就显示一张。
          </div>
        </div>

        <div className="field">
          <label>宽高比</label>
          <div className="chip-row">
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

        <div className="field">
          <label>分辨率</label>
          <div className="chip-row">
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

        <div className="btn-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={running || prompts.length === 0}
            onClick={handleGenerate}
          >
            {running ? "生成中…" : `开始生成 (${plannedJobs})`}
          </button>
          <button type="button" className="btn btn-secondary" disabled={!running} onClick={handleStop}>
            停止
          </button>
          <button type="button" className="btn btn-danger" disabled={running || jobs.length === 0} onClick={handleClear}>
            清空结果
          </button>
          <button type="button" className="btn btn-secondary" onClick={onOpenSettings}>
            管理
          </button>
        </div>

        <p className="footer-note">
          Base: <span className="mono">{settings.baseUrl}</span>
          {" · "}
          全局并发可在「管理」里调（1–8）
        </p>
      </section>

      <section className="panel">
        <h2 className="panel-title">结果</h2>
        <p className="panel-desc">
          子任务并行展示。同一 prompt 的多张图会标 <span className="mono">#1/#2…</span>。
        </p>

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

        {jobs.length === 0 ? (
          <div className="empty">还没有任务。输入 prompt，选择「每条张数」，点「开始生成」。</div>
        ) : (
          <div className="gallery">
            {jobs.map((job) => (
              <article key={job.id} className="card">
                <span
                  className={`badge ${
                    job.status === "done" ? "done" : job.status === "failed" ? "failed" : "running"
                  }`}
                >
                  {job.status} · #{job.variant}/{job.variants}
                </span>
                {job.status === "done" && job.imageUrl ? (
                  <a href={job.openUrl || job.imageUrl} target="_blank" rel="noreferrer">
                    <img src={job.imageUrl} alt={`${job.prompt} #${job.variant}`} loading="lazy" />
                  </a>
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
                <div className="card-body">
                  <div className="card-meta">
                    <strong>#{job.variant}</strong> {job.prompt}
                  </div>
                  {job.imageUrl ? (
                    <a className="mono" href={job.openUrl || job.imageUrl} target="_blank" rel="noreferrer">
                      打开原图
                    </a>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
