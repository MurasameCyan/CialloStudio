import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, generateImage, rewriteMediaUrl, runPool } from "@/lib/api";
import { log } from "@/lib/logger";
import { normalizeResolutionForModel } from "@/lib/imageModels";
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
  /** 当前真正在飞的请求数（用于验证并发是否生效） */
  inFlight: number;
  prompts: string[];
  plannedJobs: number;
  stats: { total: number; done: number; failed: number; active: number; running: number; queued: number };
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
  const [inFlight, setInFlight] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);

  const prompts = useMemo(() => splitPrompts(draft.promptText), [draft.promptText]);
  const plannedJobs = prompts.length * clampVariants(draft.variants);

  const stats = useMemo(() => {
    const total = jobs.length;
    const done = jobs.filter((j) => j.status === "done").length;
    const failed = jobs.filter((j) => j.status === "failed").length;
    const runningCount = jobs.filter((j) => j.status === "running").length;
    const queued = jobs.filter((j) => j.status === "queued").length;
    const active = runningCount + queued;
    return { total, done, failed, active, running: runningCount, queued };
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
    if (prompts.length === 0 || runningRef.current) return;

    const concurrency = clampConcurrency(draft.concurrency);
    const variants = clampVariants(draft.variants);
    const resolution = normalizeResolutionForModel(settings.model, draft.resolution);
    if (resolution !== draft.resolution) {
      log("warn", `分辨率已按模型能力纠正：${draft.resolution} → ${resolution}`, {
        model: settings.model,
      });
      setDraftState((prev) => ({ ...prev, resolution }));
    }
    const controller = new AbortController();
    abortRef.current = controller;
    runningRef.current = true;
    setRunning(true);
    setInFlight(0);

    const batch = expandJobs(prompts, variants, {
      resolution,
      aspectRatio: draft.aspectRatio,
    });
    setJobs((prev) => [...batch, ...prev]);

    log(
      "info",
      `并发生图开始：共 ${batch.length} 张（每条 ${variants} 张）· 同时最多 ${concurrency} 路请求`,
      {
        model: settings.model,
        concurrency,
        variants,
        aspectRatio: draft.aspectRatio,
        resolution,
        note: "并发=同时请求数；lite 模型可能忽略 resolution",
      },
    );

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
            resolution,
            model: settings.model,
          });

          const images = await generateImage({
            baseUrl: settings.baseUrl,
            apiKey: settings.apiKey,
            model: settings.model,
            prompt: job.prompt,
            n: 1,
            aspectRatio: draft.aspectRatio,
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
        (nextInFlight) => setInFlight(nextInFlight),
      );
      log("ok", "并发生图结束");
    } finally {
      runningRef.current = false;
      setRunning(false);
      setInFlight(0);
      abortRef.current = null;
    }
  }, [draft, prompts, settings.apiKey, settings.baseUrl, settings.model]);

  return {
    draft,
    setDraft,
    jobs,
    running,
    inFlight,
    prompts,
    plannedJobs,
    stats,
    progress,
    start,
    stop,
    clear: () => {
      if (runningRef.current) return;
      clear();
    },
  };
}

export { displayUrl };
