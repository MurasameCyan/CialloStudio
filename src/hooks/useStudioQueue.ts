import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, generateImage, rewriteMediaUrl, runPool } from "@/lib/api";
import { log } from "@/lib/logger";
import { clampConcurrency, type StudioSettings } from "@/lib/settings";
import {
  clampVariants,
  displayUrl,
  expandJobs,
  loadDraft,
  loadJobs,
  saveDraft,
  saveJobs,
  splitPrompts,
  type StudioDraft,
  type StudioJob,
} from "@/lib/studioQueue";

type QueueApi = {
  draft: StudioDraft;
  setDraft: (patch: Partial<StudioDraft>) => void;
  jobs: StudioJob[];
  running: boolean;
  prompts: string[];
  plannedJobs: number;
  stats: { total: number; done: number; failed: number; active: number };
  progress: number;
  start: () => Promise<void>;
  stop: () => void;
  clear: () => void;
};

const DEFAULT_PROMPT = "a cute orange cat sitting on a windowsill, soft daylight, minimal";

export function useStudioQueue(settings: StudioSettings): QueueApi {
  const [draft, setDraftState] = useState<StudioDraft>(() =>
    loadDraft({
      promptText: DEFAULT_PROMPT,
      aspectRatio: settings.aspectRatio,
      resolution: settings.resolution,
      variants: 4,
      concurrency: settings.concurrency,
    }),
  );
  const [jobs, setJobs] = useState<StudioJob[]>(() => loadJobs());
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;

  const prompts = useMemo(() => splitPrompts(draft.promptText), [draft.promptText]);
  const plannedJobs = prompts.length * clampVariants(draft.variants);

  const stats = useMemo(() => {
    const total = jobs.length;
    const done = jobs.filter((j) => j.status === "done").length;
    const failed = jobs.filter((j) => j.status === "failed").length;
    const active = jobs.filter((j) => j.status === "running" || j.status === "queued").length;
    return { total, done, failed, active };
  }, [jobs]);

  const progress = stats.total === 0 ? 0 : Math.round(((stats.done + stats.failed) / stats.total) * 100);

  useEffect(() => {
    saveDraft(draft);
  }, [draft]);

  useEffect(() => {
    saveJobs(jobs);
  }, [jobs]);

  const setDraft = useCallback((patch: Partial<StudioDraft>) => {
    setDraftState((prev) => ({
      ...prev,
      ...patch,
      variants: patch.variants !== undefined ? clampVariants(patch.variants) : prev.variants,
      concurrency: patch.concurrency !== undefined ? clampConcurrency(patch.concurrency) : prev.concurrency,
    }));
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    log("warn", "用户停止：已 abort 进行中的子任务");
  }, []);

  const clear = useCallback(() => {
    if (abortRef.current) return; // running
    setJobs([]);
    saveJobs([]);
  }, []);

  const start = useCallback(async () => {
    if (!settings.apiKey.trim()) {
      throw new ApiError(401, "请先在管理页填写 API Key", "missing_api_key");
    }
    if (prompts.length === 0 || running) return;

    const concurrency = clampConcurrency(draft.concurrency);
    const variants = clampVariants(draft.variants);
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);

    const batch = expandJobs(prompts, variants, {
      resolution: draft.resolution,
      aspectRatio: draft.aspectRatio,
    });
    setJobs((prev) => [...batch, ...prev]);

    log("info", `并发生图开始：${prompts.length} 条 × ${variants} 张 = ${batch.length} 子任务`, {
      model: settings.model,
      concurrency,
      aspectRatio: draft.aspectRatio,
      resolution: draft.resolution,
      mode: "fan-out-subagents",
    });

    try {
      await runPool(
        batch,
        concurrency,
        async (job) => {
          setJobs((prev) => prev.map((item) => (item.id === job.id ? { ...item, status: "running" } : item)));
          log("info", `子任务 ${job.variant}/${job.variants} 开始 ${job.id}`, {
            batchId: job.batchId,
            prompt: job.prompt,
            concurrency,
          });

          const images = await generateImage({
            baseUrl: settings.baseUrl,
            apiKey: settings.apiKey,
            model: settings.model,
            prompt: job.prompt,
            n: 1,
            aspectRatio: draft.aspectRatio,
            resolution: draft.resolution,
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

          // 展示优先用可持久化的 openUrl（同源 /v1/media/...）
          const persistable = openUrl || (!imageUrl.startsWith("blob:") ? imageUrl : undefined);
          const display = persistable || imageUrl;

          log("ok", `子任务 ${job.variant}/${job.variants} 完成 ${job.id}`, { display, openUrl });
          return { imageUrl: display, openUrl: persistable };
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
  }, [draft, prompts, running, settings.apiKey, settings.baseUrl, settings.model]);

  return {
    draft,
    setDraft,
    jobs,
    running,
    prompts,
    plannedJobs,
    stats,
    progress,
    start,
    stop,
    clear: () => {
      if (running) return;
      clear();
    },
  };
}

export { displayUrl };
