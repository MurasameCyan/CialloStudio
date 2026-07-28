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
  normalizePromptMode,
  planJobCount,
  resolvePrompts,
  saveDraft,
  saveJobs,
  type StudioDraft,
  type StudioJob,
} from "@/lib/studioQueue";
import {
  cancelServerBatch,
  cancelServerTask,
  clearServerTasks,
  createServerTasks,
  getServerTask,
  isServerTaskTerminal,
  listServerTasks,
  type ServerQueueClearMode,
  type ServerTask,
  TaskQueueError,
} from "@/lib/taskQueue";

export type ServerQueueItem = {
  id: string;
  clientJobId?: string;
  status: ServerTask["status"];
  prompt: string;
  error?: string;
  attempt: number;
  variant: number;
  variants: number;
  batchId: string;
  createdAt: number;
  updatedAt: number;
  imageUrl?: string;
};

type QueueApi = {
  draft: StudioDraft;
  setDraft: (patch: Partial<StudioDraft>) => void;
  jobs: StudioJob[];
  /** 仅浏览器本地并发生图时为 true；服务端后台入队后不锁 UI */
  running: boolean;
  /** 当前真正在飞的请求数 */
  inFlight: number;
  /** 服务端队列轮询中（关页可续跑）；不锁生成按钮 */
  serverMode: boolean;
  /** 正在提交到服务端队列（短暂，防连点） */
  enqueueBusy: boolean;
  /** 最近一次入队/队列提示 */
  queueNotice: { ok: boolean; text: string } | null;
  clearQueueNotice: () => void;
  /** 服务端队列快照 */
  serverQueue: ServerQueueItem[];
  refreshServerQueue: () => Promise<void>;
  cancelServerQueueItem: (serverTaskId: string) => Promise<void>;
  /** 取消全部进行中 / 清除失败 / 清除全部 */
  clearServerQueue: (mode: ServerQueueClearMode) => Promise<void>;
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

function toServerQueueItem(task: ServerTask): ServerQueueItem {
  return {
    id: task.id,
    clientJobId: task.clientJobId,
    status: task.status,
    prompt: task.prompt,
    error: task.error,
    attempt: task.attempt || 0,
    variant: task.variant,
    variants: task.variants,
    batchId: task.batchId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    imageUrl: task.imageUrl,
  };
}

const DEFAULT_PROMPT = "a cute orange cat sitting on a windowsill, soft daylight, minimal";

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

/** 配置类错误重试无意义；其余（网络/5xx/空图）可自动重试 */
function isAutoRetryableError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (error instanceof ApiError) {
    if (error.code === "missing_reference_image" || error.code === "missing_api_key") return false;
    if (error.status === 401 || error.status === 403) return false;
  }
  return true;
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function useStudioQueue(
  settings: StudioSettings,
  options?: { concurrencyCap?: number },
): QueueApi {
  const concurrencyCap = Math.min(8, Math.max(1, Math.round(Number(options?.concurrencyCap)) || 2));
  const concurrencyCapRef = useRef(concurrencyCap);
  concurrencyCapRef.current = concurrencyCap;

  const [draft, setDraftState] = useState<StudioDraft>(() =>
    loadDraft({
      promptText: DEFAULT_PROMPT,
      aspectRatio: settings.aspectRatio,
      resolution: settings.resolution,
      variants: DEFAULT_VARIANTS,
      concurrency: clampConcurrency(settings.concurrency, concurrencyCap),
      appendResults: false,
      autoRetry: false,
      backgroundTasks: false,
      promptMode: "lines",
    }),
  );
  const [jobs, setJobs] = useState<StudioJob[]>(() => loadJobs());
  const [running, setRunning] = useState(false);
  const [inFlight, setInFlight] = useState(0);
  const [serverMode, setServerMode] = useState(false);
  const [enqueueBusy, setEnqueueBusy] = useState(false);
  const [queueNotice, setQueueNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [serverQueue, setServerQueue] = useState<ServerQueueItem[]>([]);

  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);
  const enqueueBusyRef = useRef(false);
  const draftRef = useRef(draft);
  const settingsRef = useRef(settings);
  /** 替换模式下，只允许本批 job id 被更新，避免旧 map 回写 */
  const activeBatchIdsRef = useRef<Set<string>>(new Set());
  const serverBatchIdRef = useRef<string | null>(null);
  const serverPollTimerRef = useRef<number | null>(null);
  /** clientJobId → serverTaskId */
  const serverTaskMapRef = useRef<Map<string, string>>(new Map());
  const resumeAttemptedRef = useRef(false);

  draftRef.current = draft;
  settingsRef.current = settings;

  const stopServerPolling = useCallback(() => {
    if (serverPollTimerRef.current != null) {
      window.clearTimeout(serverPollTimerRef.current);
      serverPollTimerRef.current = null;
    }
  }, []);

  const refreshServerQueue = useCallback(async () => {
    try {
      const res = await listServerTasks({ limit: 40 });
      setServerQueue(res.items.map(toServerQueueItem));
    } catch (e) {
      // 未登录 / 非 VIP / 服务未起：静默
      if (e instanceof TaskQueueError && (e.status === 401 || e.status === 403)) {
        setServerQueue([]);
        return;
      }
      log("warn", "刷新服务端队列失败", e instanceof Error ? e.message : String(e));
    }
  }, []);

  const prompts = useMemo(
    () => resolvePrompts(draft.promptText, draft.promptMode),
    [draft.promptText, draft.promptMode],
  );
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

  const clearQueueNotice = useCallback(() => setQueueNotice(null), []);

  // 用户组并发上限变化时，把 draft 收回到 cap 内
  useEffect(() => {
    setDraftState((prev) => {
      const nextVal = clampConcurrency(prev.concurrency, concurrencyCap);
      if (nextVal === prev.concurrency) return prev;
      const next = { ...prev, concurrency: nextVal };
      draftRef.current = next;
      return next;
    });
  }, [concurrencyCap]);

  const setDraft = useCallback((patch: Partial<StudioDraft>) => {
    setDraftState((prev) => {
      const cap = concurrencyCapRef.current;
      const next: StudioDraft = {
        ...prev,
        ...patch,
        variants: patch.variants !== undefined ? clampVariants(Number(patch.variants)) : clampVariants(prev.variants),
        concurrency:
          patch.concurrency !== undefined
            ? clampConcurrency(Number(patch.concurrency), cap)
            : clampConcurrency(prev.concurrency, cap),
        appendResults:
          patch.appendResults !== undefined ? patch.appendResults === true : prev.appendResults === true,
        autoRetry: patch.autoRetry !== undefined ? patch.autoRetry === true : prev.autoRetry === true,
        backgroundTasks:
          patch.backgroundTasks !== undefined
            ? patch.backgroundTasks === true
            : prev.backgroundTasks === true,
        promptMode:
          patch.promptMode !== undefined
            ? normalizePromptMode(patch.promptMode)
            : normalizePromptMode(prev.promptMode),
      };
      draftRef.current = next;
      return next;
    });
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    const batchId = serverBatchIdRef.current;
    // 取消当前跟踪的服务端任务（可能跨多个 batch）
    const tracked = [...serverTaskMapRef.current.values()];
    if (batchId) {
      void cancelServerBatch(batchId).catch((e) => {
        log("warn", "取消服务端批次失败", e instanceof Error ? e.message : String(e));
      });
    }
    for (const sid of tracked) {
      void cancelServerTask(sid).catch(() => undefined);
    }
    serverTaskMapRef.current = new Map();
    serverBatchIdRef.current = null;
    stopServerPolling();
    runningRef.current = false;
    setRunning(false);
    setInFlight(0);
    setServerMode(false);
    log("warn", "用户停止：已 abort / 取消进行中的子任务");
    void refreshServerQueue();
  }, [refreshServerQueue, stopServerPolling]);

  const clear = useCallback(() => {
    if (runningRef.current) return;
    activeBatchIdsRef.current = new Set();
    serverBatchIdRef.current = null;
    serverTaskMapRef.current = new Map();
    setJobs([]);
    saveJobs([]);
  }, []);

  const applyServerTaskToJobs = useCallback((clientJobId: string, task: ServerTask) => {
    setJobs((prev) =>
      prev.map((item) => {
        if (item.id !== clientJobId) return item;
        if (task.status === "done") {
          return {
            ...item,
            status: "done",
            imageUrl: task.imageUrl,
            openUrl:
              task.imageUrl &&
              !task.imageUrl.startsWith("blob:") &&
              !task.imageUrl.startsWith("data:")
                ? task.imageUrl
                : item.openUrl,
            error: undefined,
            finishedAt: task.finishedAt || Date.now(),
            serverTaskId: task.id,
          };
        }
        if (task.status === "failed" || task.status === "cancelled") {
          return {
            ...item,
            status: "failed",
            error: task.error || (task.status === "cancelled" ? "已取消" : "生成失败"),
            finishedAt: task.finishedAt || Date.now(),
            serverTaskId: task.id,
          };
        }
        return {
          ...item,
          status: task.status === "queued" ? "queued" : "running",
          error: task.error,
          serverTaskId: task.id,
        };
      }),
    );
    setServerQueue((prev) => {
      const nextItem = toServerQueueItem(task);
      const idx = prev.findIndex((p) => p.id === task.id);
      if (idx < 0) return [nextItem, ...prev].slice(0, 40);
      const copy = prev.slice();
      copy[idx] = nextItem;
      return copy;
    });
  }, []);

  const cancelServerQueueItem = useCallback(
    async (serverTaskId: string) => {
      const task = await cancelServerTask(serverTaskId);
      setServerQueue((prev) =>
        prev.map((item) => (item.id === task.id ? toServerQueueItem(task) : item)),
      );
      if (task.clientJobId) {
        applyServerTaskToJobs(task.clientJobId, task);
        serverTaskMapRef.current.delete(task.clientJobId);
      } else {
        setJobs((prev) =>
          prev.map((j) =>
            j.serverTaskId === task.id
              ? {
                  ...j,
                  status: "failed",
                  error: task.error || "已取消",
                  finishedAt: Date.now(),
                }
              : j,
          ),
        );
      }
      if (serverTaskMapRef.current.size === 0) {
        setInFlight(0);
        setServerMode(false);
        serverBatchIdRef.current = null;
        stopServerPolling();
      }
    },
    [applyServerTaskToJobs, stopServerPolling],
  );

  const clearServerQueue = useCallback(
    async (mode: ServerQueueClearMode) => {
      const result = await clearServerTasks(mode);
      const nextItems = result.items.map(toServerQueueItem);
      setServerQueue(nextItems);
      const keepIds = new Set(result.items.map((t) => t.id));

      if (mode === "cancel_all") {
        setJobs((prev) =>
          prev.map((j) =>
            j.serverTaskId && (j.status === "queued" || j.status === "running")
              ? {
                  ...j,
                  status: "failed",
                  error: "已取消",
                  finishedAt: Date.now(),
                }
              : j,
          ),
        );
        serverTaskMapRef.current = new Map();
        serverBatchIdRef.current = null;
        stopServerPolling();
        setInFlight(0);
        setServerMode(false);
        // 成功类批量操作：只记日志，不在创作台弹提示条
        log(
          "ok",
          `已取消全部进行中任务${result.cancelled ? ` · ${result.cancelled}` : ""}`,
        );
        return;
      }

      if (mode === "clear_all") {
        serverTaskMapRef.current = new Map();
        serverBatchIdRef.current = null;
        stopServerPolling();
        setInFlight(0);
        setServerMode(false);
        setJobs((prev) => prev.filter((j) => !j.serverTaskId));
        log(
          "ok",
          `已清除全部服务端任务${typeof result.removed === "number" ? ` · ${result.removed}` : ""}`,
        );
        return;
      }

      if (mode === "clear_failed") {
        setJobs((prev) =>
          prev.filter((j) => {
            if (!j.serverTaskId) return true;
            if (j.status !== "failed") return true;
            return keepIds.has(j.serverTaskId);
          }),
        );
        log(
          "ok",
          `已清除失败/取消任务${typeof result.removed === "number" ? ` · ${result.removed}` : ""}`,
        );
        return;
      }

      // clear_done
      setJobs((prev) =>
        prev.filter((j) => {
          if (!j.serverTaskId || j.status !== "done") return true;
          return keepIds.has(j.serverTaskId);
        }),
      );
      log(
        "ok",
        `已清除已完成任务${typeof result.removed === "number" ? ` · ${result.removed}` : ""}`,
      );
    },
    [stopServerPolling],
  );

  const pollServerTasks = useCallback(async () => {
    const map = serverTaskMapRef.current;
    if (map.size === 0) {
      // 服务端路径不占用 running；仅清 serverMode
      setInFlight(0);
      setServerMode(false);
      serverBatchIdRef.current = null;
      stopServerPolling();
      void refreshServerQueue();
      return;
    }

    let pending = 0;
    let runningCount = 0;
    const entries = [...map.entries()];
    await Promise.all(
      entries.map(async ([clientJobId, serverTaskId]) => {
        try {
          const task = await getServerTask(serverTaskId);
          applyServerTaskToJobs(clientJobId, task);
          if (isServerTaskTerminal(task.status)) {
            map.delete(clientJobId);
          } else {
            pending += 1;
            if (task.status === "running") runningCount += 1;
          }
        } catch (e) {
          log(
            "warn",
            `轮询服务端任务失败 ${serverTaskId}`,
            e instanceof Error ? e.message : String(e),
          );
          pending += 1;
        }
      }),
    );

    setInFlight(runningCount);
    setServerMode(true);
    if (pending === 0) {
      setInFlight(0);
      setServerMode(false);
      serverBatchIdRef.current = null;
      stopServerPolling();
      log("ok", "服务端批次已全部结束");
      void refreshServerQueue();
      return;
    }

    serverPollTimerRef.current = window.setTimeout(() => {
      void pollServerTasks();
    }, 1500);
  }, [applyServerTaskToJobs, refreshServerQueue, stopServerPolling]);

  // 启动：1) 本地带 serverTaskId 的 inflight  2) 服务端仍有 queued/running 的任务
  useEffect(() => {
    if (resumeAttemptedRef.current) return;
    resumeAttemptedRef.current = true;

    void (async () => {
      const localPending = jobs.filter(
        (j) =>
          j.serverTaskId &&
          (j.status === "queued" || j.status === "running"),
      );
      const map = new Map<string, string>();
      for (const j of localPending) {
        if (j.serverTaskId) map.set(j.id, j.serverTaskId);
      }

      try {
        const res = await listServerTasks({ limit: 40 });
        setServerQueue(res.items.map(toServerQueueItem));
        const active = res.items.filter(
          (t) => t.status === "queued" || t.status === "running",
        );
        if (active.length > 0) {
          // 用服务端任务补全/重建本地 job（关页后 local 可能被清空或曾被误标 failed）
          setJobs((prev) => {
            const byServerId = new Map(
              prev.filter((j) => j.serverTaskId).map((j) => [j.serverTaskId!, j]),
            );
            const byClientId = new Map(prev.map((j) => [j.id, j]));
            const next = prev.slice();
            for (const t of active) {
              map.set(t.clientJobId || t.id, t.id);
              const existing =
                (t.clientJobId ? byClientId.get(t.clientJobId) : undefined) ||
                byServerId.get(t.id);
              if (existing) {
                const idx = next.findIndex((j) => j.id === existing.id);
                if (idx >= 0) {
                  next[idx] = {
                    ...next[idx],
                    status: t.status === "queued" ? "queued" : "running",
                    serverTaskId: t.id,
                    error: t.error,
                    batchId: t.batchId || next[idx].batchId,
                  };
                }
              } else {
                next.unshift({
                  id: t.clientJobId || t.id,
                  batchId: t.batchId,
                  variant: t.variant,
                  variants: t.variants,
                  prompt: t.prompt,
                  status: t.status === "queued" ? "queued" : "running",
                  createdAt: t.createdAt,
                  resolution: undefined,
                  aspectRatio: undefined,
                  serverTaskId: t.id,
                  error: t.error,
                });
              }
            }
            return next.slice(0, 120);
          });
          for (const t of active) {
            if (t.clientJobId) map.set(t.clientJobId, t.id);
            else map.set(t.id, t.id);
          }
          serverBatchIdRef.current = active[0]?.batchId || null;
        }
      } catch (e) {
        log(
          "info",
          "启动时未能拉取服务端队列（可能未登录/服务未起）",
          e instanceof Error ? e.message : String(e),
        );
      }

      if (map.size === 0) return;
      serverTaskMapRef.current = map;
      // 服务端恢复不锁 running / 不挡生成按钮
      setServerMode(true);
      log("info", `恢复服务端任务轮询 ${map.size} 个`);
      void pollServerTasks();
    })();
    // 仅挂载一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = useCallback(async () => {
    const currentSettings = settingsRef.current;
    const currentDraft = draftRef.current;
    const currentPrompts = resolvePrompts(currentDraft.promptText, currentDraft.promptMode);

    const apiKey = typeof currentSettings.apiKey === "string" ? currentSettings.apiKey : "";
    if (!apiKey.trim()) {
      throw new ApiError(401, "请先在管理页填写 API Key", "missing_api_key");
    }
    if (currentPrompts.length === 0) return;

    // 强制数字，避免 localStorage / 事件值变成字符串
    const concurrency = clampConcurrency(
      Number(currentDraft.concurrency),
      concurrencyCapRef.current,
    );
    const variants = clampVariants(Number(currentDraft.variants));
    const appendResults = currentDraft.appendResults === true;
    const autoRetry = currentDraft.autoRetry === true;
    const useServerQueue = currentDraft.backgroundTasks === true;
    const resolution = normalizeResolutionForModel(currentSettings.model, currentDraft.resolution);
    const aspectRatio = currentDraft.aspectRatio;

    if (resolution !== currentDraft.resolution) {
      log("warn", `分辨率已按模型能力纠正：${currentDraft.resolution} → ${resolution}`, {
        model: currentSettings.model,
      });
      setDraft({ resolution });
    }

    // 服务端后台：不锁 running，允许多次入队；仅短暂 enqueueBusy 防连点
    if (useServerQueue) {
      if (runningRef.current) {
        log("warn", "浏览器本地生成进行中，请先停止再入队");
        setQueueNotice({ ok: false, text: "本地生成进行中，请先停止再入队" });
        return;
      }
      if (enqueueBusyRef.current) {
        log("warn", "正在提交服务端队列，忽略重复点击");
        return;
      }

      const batch = expandJobs(currentPrompts, variants, concurrency, {
        resolution,
        aspectRatio,
      });
      const batchIds = new Set(batch.map((j) => j.id));

      enqueueBusyRef.current = true;
      setEnqueueBusy(true);
      setQueueNotice(null);

      if (appendResults) {
        setJobs((prev) => [...batch, ...prev].slice(0, 120));
      } else {
        // 替换：保留仍在服务端排队/运行的旧任务，避免把续跑任务冲掉
        setJobs((prev) => {
          const keep = prev.filter(
            (j) =>
              j.serverTaskId &&
              (j.status === "queued" || j.status === "running") &&
              !batchIds.has(j.id),
          );
          return [...batch, ...keep].slice(0, 120);
        });
      }

      log(
        "info",
        `服务端入队：本次 ${batch.length} 张 = ${currentPrompts.length} 条 prompt × ${variants} 生图 × ${concurrency} 并发 · 自动重试=${autoRetry ? "开" : "关"}`,
        {
          concurrency,
          variants,
          promptCount: currentPrompts.length,
          batchLength: batch.length,
          appendResults,
          autoRetry,
          aspectRatio,
          resolution,
          model: currentSettings.model,
        },
      );

      try {
        const modelId =
          typeof currentSettings.model === "string" ? currentSettings.model.trim() : "";
        const isEdit =
          modelId === "grok-imagine-image-edit" ||
          /imagine.*image.*edit|image.*edit|img.?edit/i.test(modelId);
        const ref =
          isEdit && typeof currentDraft.referenceImageUrl === "string"
            ? currentDraft.referenceImageUrl.trim()
            : "";
        if (isEdit && !ref) {
          throw new ApiError(400, "当前为图生图模型，请先上传参考图", "missing_reference_image");
        }

        const created = await createServerTasks({
          baseUrl: currentSettings.baseUrl,
          apiKey,
          model: currentSettings.model,
          aspectRatio,
          resolution,
          autoRetry,
          referenceImageUrl: ref || undefined,
          batchId: batch[0]?.batchId,
          jobs: batch.map((j) => ({
            prompt: j.prompt,
            clientJobId: j.id,
            variant: j.variant,
            variants: j.variants,
            batchId: j.batchId,
          })),
        });

        const map = new Map(serverTaskMapRef.current);
        for (const t of created.tasks) {
          const clientId = t.clientJobId;
          if (!clientId) continue;
          map.set(clientId, t.id);
        }
        serverTaskMapRef.current = map;
        serverBatchIdRef.current = created.batchId;
        setServerMode(true);
        // 服务端路径：不 setRunning(true)，创作台生成按钮保持可点
        setJobs((prev) =>
          prev.map((item) => {
            const sid = map.get(item.id);
            return sid
              ? { ...item, status: "queued", serverTaskId: sid, error: undefined }
              : item;
          }),
        );
        log("ok", `已提交服务端队列 ${created.tasks.length} 个任务`, {
          batchId: created.batchId,
          stats: created.stats,
        });
        setServerQueue((prev) => {
          const incoming = created.tasks.map(toServerQueueItem);
          const ids = new Set(incoming.map((t) => t.id));
          return [...incoming, ...prev.filter((p) => !ids.has(p.id))].slice(0, 40);
        });
        log("ok", `已入队 ${created.tasks.length} 个任务`);
        void pollServerTasks();
        return;
      } catch (error) {
        const message =
          error instanceof TaskQueueError || error instanceof ApiError
            ? error.message
            : error instanceof Error
              ? error.message
              : "提交服务端任务失败";
        log("error", "服务端队列不可用，本批失败", message);
        setJobs((prev) =>
          prev.map((item) =>
            batchIds.has(item.id)
              ? {
                  ...item,
                  status: "failed",
                  error: message,
                  finishedAt: Date.now(),
                }
              : item,
          ),
        );
        setQueueNotice({ ok: false, text: message });
        return;
      } finally {
        enqueueBusyRef.current = false;
        setEnqueueBusy(false);
      }
    }

    // —— 浏览器本地并发生图 ——
    if (runningRef.current) {
      log("warn", "已有生成任务在运行，忽略重复开始");
      return;
    }
    if (enqueueBusyRef.current) {
      log("warn", "服务端入队进行中，请稍候");
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    runningRef.current = true;
    setRunning(true);
    setInFlight(0);
    // 本地跑不打断已有服务端轮询；仅本批走浏览器
    setQueueNotice(null);

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
      `并发生图开始：本次 ${batch.length} 张 = ${currentPrompts.length} 条 prompt × ${variants} 生图 × ${concurrency} 并发 · worker=${effectiveWorkers} · ${appendResults ? "追加" : "替换"}模式 · 自动重试=${autoRetry ? "开" : "关"} · 后台=浏览器`,
      {
        concurrency,
        effectiveWorkers,
        variants,
        perPrompt,
        promptCount: currentPrompts.length,
        batchLength: batch.length,
        appendResults,
        autoRetry,
        useServerQueue: false,
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

          patchJob(job.id, { status: "running", error: undefined });
          log("info", `子任务 ${job.variant}/${job.variants} 开始 ${job.id}`, {
            batchId: job.batchId,
            concurrency,
            resolution,
            model: currentSettings.model,
            autoRetry,
            hasReference: Boolean(
              typeof currentDraft.referenceImageUrl === "string" &&
                currentDraft.referenceImageUrl.trim(),
            ),
          });

          // 仅编辑模型（如 grok-imagine-image-edit）携带参考图 → /images/edits
          const modelId =
            typeof currentSettings.model === "string" ? currentSettings.model.trim() : "";
          const isEdit =
            modelId === "grok-imagine-image-edit" ||
            /imagine.*image.*edit|image.*edit|img.?edit/i.test(modelId);
          const ref =
            isEdit && typeof currentDraft.referenceImageUrl === "string"
              ? currentDraft.referenceImageUrl.trim()
              : "";
          if (isEdit && !ref) {
            throw new ApiError(
              400,
              "当前为图生图模型，请先上传参考图",
              "missing_reference_image",
            );
          }

          let attempt = 0;
          for (;;) {
            if (controller.signal.aborted) {
              throw new DOMException("Aborted", "AbortError");
            }
            attempt += 1;
            try {
              const images = await generateImage({
                baseUrl: currentSettings.baseUrl,
                apiKey,
                model: currentSettings.model,
                prompt: job.prompt,
                n: 1,
                aspectRatio,
                resolution,
                imageUrl: ref || undefined,
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
                attempts: attempt,
              });
              return { imageUrl: display, openUrl: persistable };
            } catch (error) {
              // 运行中也可关掉开关，立即停止后续重试
              const retryEnabled = draftRef.current.autoRetry === true;
              if (!retryEnabled || !isAutoRetryableError(error) || controller.signal.aborted) {
                throw error;
              }
              const waitMs = Math.min(8000, 1000 * 2 ** Math.min(attempt - 1, 3));
              const reason =
                error instanceof ApiError
                  ? error.message
                  : error instanceof Error
                    ? error.message
                    : "生成失败";
              log(
                "warn",
                `子任务 ${job.variant}/${job.variants} 失败，${waitMs}ms 后自动重试 #${attempt + 1} ${job.id}`,
                reason,
              );
              patchJob(job.id, {
                status: "running",
                error: `自动重试中 · 第 ${attempt} 次失败：${reason.slice(0, 120)}`,
              });
              await waitForRetry(waitMs, controller.signal);
            }
          }
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
              message = `${message.slice(0, 280)}…`;
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
      // 浏览器本地路径收尾；服务端轮询独立，勿清掉服务端 inFlight
      runningRef.current = false;
      setRunning(false);
      if (serverTaskMapRef.current.size === 0) {
        setInFlight(0);
      }
      abortRef.current = null;
    }
  }, [pollServerTasks, setDraft]);

  return {
    draft,
    setDraft,
    jobs,
    running,
    inFlight,
    serverMode,
    enqueueBusy,
    queueNotice,
    clearQueueNotice,
    serverQueue,
    refreshServerQueue,
    cancelServerQueueItem,
    clearServerQueue,
    prompts,
    plannedJobs,
    stats,
    progress,
    start,
    stop,
    clear,
  };
}
