import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, generateImage, rewriteMediaUrl } from "@/lib/api";
import { normalizeResolutionForModel } from "@/lib/imageModels";
import { log } from "@/lib/logger";
import { runPool } from "@/lib/runPool";
import { clampConcurrency, type StudioSettings } from "@/lib/settings";
import {
  clampVariants,
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
  /** 当前真正在飞的请求数 */
  inFlight: number;
  prompts: string[];
  plannedJobs: number;
  stats: {
    total: number;
    done: number;
    failed: number;
    active: number;
    running: number;
    queued: number;
  };
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
      concurrency: clampConcurrency(settings.concurrency),
      appendResults: false,
    }),
  );
  const [jobs, setJobs] = useState<StudioJob[]>(() => loadJobs());
  const [running, setRunning] = useState(false);
  const [inFlight, setInFlight] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);
  const draftRef = useRef(draft);
  const settingsRef = useRef(settings);

  draftRef.current = draft;
  settingsRef.current = settings;

  const prompts = useMemo(() => splitPrompts(draft.promptText), [draft.promptText]);
  const plannedJobs = prompts.length * clampVariants(draft.variants);

  const stats = useMemo(() => {
    const total = jobs.length;
    const done = jobs.filter((j) => j.status === "done").length;
    const failed = jobs.filter((j) => j.status === "failed").length;
    const runningCount = jobs.filter((j) => j.status === "running").length;
    const queued = jobs.filter((j) => j.status === "queued").length;
    return {
      total,
      done,
      failed,
      active: runningCount + queued,
      running: runningCount,
      queued,
    };
  }, [jobs]);

  const progress = stats.total === 0 ? 0 : Math.round(((stats.done + stats.failed) / stats.total) * 100);

  useEffect(() => {
    saveDraft(draft);
  }, [draft]);

  useEffect(() => {
    saveJobs(jobs);
  }, [jobs]);

  const setDraft = useCallback((patch: Partial<StudioDraft>) => {
    setDraftState((prev) => {
      const next: StudioDraft = {
        ...prev,
        ...patch,
        variants: patch.variants !== undefined ? clampVariants(patch.variants) : prev.variants,
        concurrency:
          patch.concurrency !== undefined ? clampConcurrency(patch.concurrency) : clampConcurrency(prev.concurrency),
      };
      draftRef.current = next;
      return next;
    });
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    log("warn", "用户停止：已 abort 进行中的子任务");
  }, []);

  const clear = useCallback(() => {
    if (runningRef.current) return;
    setJobs([]);
    saveJobs([]);
  }, []);

  const start = useCallback(async () => {
    const currentSettings = settingsRef.current;
    const currentDraft = draftRef.current;
    const currentPrompts = splitPrompts(currentDraft.promptText);

    if (!currentSettings.apiKey.trim()) {
      throw new ApiError(401, "请先在管理页填写 API Key", "missing_api_key");
    }
    if (currentPrompts.length === 0) return;
    if (runningRef.current) {
      log("warn", "已有生成任务在运行，忽略重复开始");
      return;
    }

    // 强制数字，避免 localStorage / 事件值变成字符串
    const concurrency = clampConcurrency(Number(currentDraft.concurrency));
    const variants = clampVariants(Number(currentDraft.variants));
    const resolution = normalizeResolutionForModel(currentSettings.model, currentDraft.resolution);
    const aspectRatio = currentDraft.aspectRatio;

    if (resolution !== currentDraft.resolution) {
      log("warn", `分辨率已按模型能力纠正：${currentDraft.resolution} → ${resolution}`, {
        model: currentSettings.model,
      });
      setDraft({ resolution });
    }

    const controller = new AbortController();
    abortRef.current = controller;
    runningRef.current = true;
    setRunning(true);
    setInFlight(0);

    const batch = expandJobs(currentPrompts, variants, {
      resolution,
      aspectRatio,
    });

    // 默认替换结果墙，避免历史累积看起来像“一次出了十几张”
    if (currentDraft.appendResults) {
      setJobs((prev) => [...batch, ...prev]);
    } else {
      setJobs(batch);
    }

    log(
      "info",
      `并发生图开始：本次 ${batch.length} 张 · worker=${concurrency} · ${currentDraft.appendResults ? "追加" : "替换"}模式`,
      {
        concurrency,
        variants,
        appendResults: currentDraft.appendResults,
        aspectRatio,
        resolution,
        model: currentSettings.model,
      },
    );

    try {
      await runPool(
        batch,
        concurrency,
        async (job) => {
          if (controller.signal.aborted) {
            throw new DOMException("Aborted", "AbortError");
          }

          setJobs((prev) => prev.map((item) => (item.id === job.id ? { ...item, status: "running" } : item)));
          log("info", `子任务 ${job.variant}/${job.variants} 开始 ${job.id}`, {
            batchId: job.batchId,
            concurrency,
            resolution,
            model: currentSettings.model,
          });

          const images = await generateImage({
            baseUrl: currentSettings.baseUrl,
            apiKey: currentSettings.apiKey,
            model: currentSettings.model,
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
              : rewriteMediaUrl(imageUrl, currentSettings.baseUrl));

          const persistable = openUrl || (!imageUrl.startsWith("blob:") ? imageUrl : undefined);
          const display = persistable || imageUrl;

          log("ok", `子任务 ${job.variant}/${job.variants} 完成 ${job.id}`, { display, openUrl });
          return { imageUrl: display, openUrl: persistable };
        },
        {
          onInFlightChange: (n) => setInFlight(n),
          onLog: (message, detail) => log("info", message, detail),
          onItemSettled: (index, result) => {
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
              return;
            }

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
          },
        },
      );
      log("ok", "并发生图结束");
    } finally {
      runningRef.current = false;
      setRunning(false);
      setInFlight(0);
      abortRef.current = null;
    }
  }, [setDraft]);

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
    clear,
  };
}
