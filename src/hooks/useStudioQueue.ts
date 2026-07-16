import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, generateImage, rewriteMediaUrl } from "@/lib/api";
import { normalizeResolutionForModel } from "@/lib/imageModels";
import { log } from "@/lib/logger";
import { runPool } from "@/lib/runPool";
import { clampConcurrency, type StudioSettings } from "@/lib/settings";
import {
  DEFAULT_VARIANTS,
  clampVariants,
  expandJobs,
  loadDraft,
  loadJobs,
  planJobCount,
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
      variants: DEFAULT_VARIANTS,
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
  /** 替换模式下，只允许本批 job id 被更新，避免旧 map 回写 */
  const activeBatchIdsRef = useRef<Set<string>>(new Set());

  draftRef.current = draft;
  settingsRef.current = settings;

  const prompts = useMemo(() => splitPrompts(draft.promptText), [draft.promptText]);
  // 总张数 = Prompt 条数 × 生图数量 × 并发数
  const plannedJobs = planJobCount(prompts, draft.variants, draft.concurrency);

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
        variants: patch.variants !== undefined ? clampVariants(Number(patch.variants)) : clampVariants(prev.variants),
        concurrency:
          patch.concurrency !== undefined
            ? clampConcurrency(Number(patch.concurrency))
            : clampConcurrency(prev.concurrency),
        appendResults:
          patch.appendResults !== undefined ? patch.appendResults === true : prev.appendResults === true,
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
    activeBatchIdsRef.current = new Set();
    setJobs([]);
    saveJobs([]);
  }, []);

  const start = useCallback(async () => {
    const currentSettings = settingsRef.current;
    const currentDraft = draftRef.current;
    const currentPrompts = splitPrompts(currentDraft.promptText);

    const apiKey = typeof currentSettings.apiKey === "string" ? currentSettings.apiKey : "";
    if (!apiKey.trim()) {
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
    const appendResults = currentDraft.appendResults === true;
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

    // 总张数 = 生图数量 × 并发数（× prompt 条数）
    const batch = expandJobs(currentPrompts, variants, concurrency, {
      resolution,
      aspectRatio,
    });
    const batchIds = new Set(batch.map((j) => j.id));
    activeBatchIdsRef.current = batchIds;

    // 默认替换结果墙：整表换成 batch，绝不再 prepend 历史
    if (appendResults) {
      setJobs((prev) => [...batch, ...prev].slice(0, 120));
    } else {
      setJobs(batch);
      saveJobs(batch);
    }

    // 并发既决定总张数，也是 worker 上限；总张数已含 concurrency，通常 effectiveWorkers === concurrency
    const effectiveWorkers = Math.max(1, Math.min(concurrency, batch.length));
    const perPrompt = variants * concurrency;
    log(
      "info",
      `并发生图开始：本次 ${batch.length} 张 = ${currentPrompts.length} 条 prompt × ${variants} 生图 × ${concurrency} 并发 · worker=${effectiveWorkers} · ${appendResults ? "追加" : "替换"}模式`,
      {
        concurrency,
        effectiveWorkers,
        variants,
        perPrompt,
        promptCount: currentPrompts.length,
        batchLength: batch.length,
        appendResults,
        aspectRatio,
        resolution,
        model: currentSettings.model,
      },
    );

    const expected = currentPrompts.length * variants * concurrency;
    if (batch.length !== expected) {
      log("warn", "batch 长度与预期不符", {
        expected,
        actual: batch.length,
      });
    }

    const patchJob = (jobId: string, patch: Partial<StudioJob>) => {
      if (!activeBatchIdsRef.current.has(jobId)) return;
      setJobs((prev) => {
        // 替换模式：若当前列表意外还含旧 id，只保留 active batch + 更新
        const base = appendResults ? prev : prev.filter((item) => activeBatchIdsRef.current.has(item.id));
        return base.map((item) => (item.id === jobId ? { ...item, ...patch } : item));
      });
    };

    try {
      await runPool(
        batch,
        concurrency,
        async (job) => {
          if (controller.signal.aborted) {
            throw new DOMException("Aborted", "AbortError");
          }

          patchJob(job.id, { status: "running" });
          log("info", `子任务 ${job.variant}/${job.variants} 开始 ${job.id}`, {
            batchId: job.batchId,
            concurrency,
            resolution,
            model: currentSettings.model,
          });

          const images = await generateImage({
            baseUrl: currentSettings.baseUrl,
            apiKey,
            model: currentSettings.model,
            prompt: job.prompt,
            n: 1,
            aspectRatio,
            resolution,
            signal: controller.signal,
          });

          // 只取第一张：即使上游 data[] 多图也不扩成多卡片
          const first = images[0];
          const imageUrl = first?.url;
          if (!imageUrl) {
            throw new ApiError(200, "未返回图片 URL", "invalid_response");
          }
          if (images.length > 1) {
            log("warn", `上游返回 ${images.length} 张，本任务只采用第 1 张`, { jobId: job.id });
          }

          // imageUrl：优先 generateImage 已 blob 化的展示地址（<img> 可直接用）
          // openUrl：同源 /v1/media 路径，打开原图 / 持久化时靠 cookie 代理
          const openUrl =
            first?.openUrl ||
            (imageUrl.startsWith("blob:") || imageUrl.startsWith("data:")
              ? undefined
              : rewriteMediaUrl(imageUrl, currentSettings.baseUrl));

          const display = imageUrl;
          const persistable =
            openUrl ||
            (!imageUrl.startsWith("blob:") && !imageUrl.startsWith("data:") ? imageUrl : undefined);

          log("ok", `子任务 ${job.variant}/${job.variants} 完成 ${job.id}`, {
            display: display.startsWith("blob:") ? "blob:…" : display,
            openUrl: persistable,
          });
          return { imageUrl: display, openUrl: persistable };
        },
        {
          onInFlightChange: (n) => setInFlight(n),
          onLog: (message, detail) => log("info", message, detail),
          onItemSettled: (index, result) => {
            const job = batch[index];
            if (!job) return;
            if (result.status === "fulfilled") {
              patchJob(job.id, {
                status: "done",
                imageUrl: result.value.imageUrl,
                openUrl: result.value.openUrl,
                finishedAt: Date.now(),
              });
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
            patchJob(job.id, {
              status: "failed",
              error: message,
              finishedAt: Date.now(),
            });
          },
        },
      );
      log(
        "ok",
        `并发生图结束：本批 ${batch.length} 张 · 结果墙模式=${appendResults ? "追加" : "替换"}`,
      );
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
