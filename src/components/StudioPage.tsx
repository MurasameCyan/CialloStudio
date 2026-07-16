import { useMemo, useRef, useState } from "react";
import { ApiError, generateImage, runPool } from "@/lib/api";
import { ASPECT_RATIOS, RESOLUTIONS, type StudioSettings } from "@/lib/settings";

type JobStatus = "queued" | "running" | "done" | "failed";

type Job = {
  id: string;
  prompt: string;
  status: JobStatus;
  imageUrl?: string;
  error?: string;
  createdAt: number;
  finishedAt?: number;
};

type Props = {
  settings: StudioSettings;
  onOpenSettings: () => void;
};

function splitPrompts(raw: string): string[] {
  return raw
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function StudioPage({ settings, onOpenSettings }: Props) {
  const [promptText, setPromptText] = useState("a cute orange cat sitting on a windowsill, soft daylight, minimal");
  const [aspectRatio, setAspectRatio] = useState(settings.aspectRatio);
  const [resolution, setResolution] = useState(settings.resolution);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const prompts = useMemo(() => splitPrompts(promptText), [promptText]);
  const stats = useMemo(() => {
    const total = jobs.length;
    const done = jobs.filter((j) => j.status === "done").length;
    const failed = jobs.filter((j) => j.status === "failed").length;
    const active = jobs.filter((j) => j.status === "running" || j.status === "queued").length;
    return { total, done, failed, active };
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

    const batch: Job[] = prompts.map((prompt) => ({
      id: uid(),
      prompt,
      status: "queued",
      createdAt: Date.now(),
    }));
    setJobs((prev) => [...batch, ...prev]);

    try {
      await runPool(
        batch,
        settings.concurrency,
        async (job) => {
          setJobs((prev) =>
            prev.map((item) => (item.id === job.id ? { ...item, status: "running" } : item)),
          );
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
          return imageUrl;
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
                      imageUrl: result.value,
                      finishedAt: Date.now(),
                    }
                  : item,
              ),
            );
          } else {
            const reason = result.reason;
            const message =
              reason instanceof ApiError
                ? reason.message
                : reason instanceof Error
                  ? reason.message
                  : "生成失败";
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
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  function handleStop() {
    abortRef.current?.abort();
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
          每行一个 prompt，按并发数同时请求 <span className="mono">/images/generations</span>。当前模型：
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
          <div className="field-hint">已识别 {prompts.length} 条 · 并发 {settings.concurrency}</div>
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
            {running ? "生成中…" : `开始生成 (${prompts.length})`}
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
        </p>
      </section>

      <section className="panel">
        <h2 className="panel-title">结果</h2>
        <p className="panel-desc">多任务并行展示。失败任务会保留错误信息，可修改 prompt 后重试。</p>

        <div className="kpi-row">
          <div className="kpi">
            <div className="kpi-label">总计</div>
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
          <div className="empty">还没有任务。输入 prompt 后点「开始生成」。</div>
        ) : (
          <div className="gallery">
            {jobs.map((job) => (
              <article key={job.id} className="card">
                <span className={`badge ${job.status === "done" ? "done" : job.status === "failed" ? "failed" : "running"}`}>
                  {job.status}
                </span>
                {job.status === "done" && job.imageUrl ? (
                  <a href={job.imageUrl} target="_blank" rel="noreferrer">
                    <img src={job.imageUrl} alt={job.prompt} loading="lazy" />
                  </a>
                ) : job.status === "failed" ? (
                  <div className="skeleton" style={{ animation: "none", display: "grid", placeItems: "center", padding: 16 }}>
                    <span style={{ color: "var(--danger)", fontSize: 13, textAlign: "center" }}>{job.error}</span>
                  </div>
                ) : (
                  <div className="skeleton" />
                )}
                <div className="card-body">
                  <div className="card-meta">{job.prompt}</div>
                  {job.imageUrl ? (
                    <a className="mono" href={job.imageUrl} target="_blank" rel="noreferrer">
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
