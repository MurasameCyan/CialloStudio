import { clampConcurrency } from "./settings";

export type JobStatus = "queued" | "running" | "done" | "failed";

export type StudioJob = {
  id: string;
  batchId: string;
  variant: number;
  variants: number;
  prompt: string;
  status: JobStatus;
  /** 展示用 URL：优先 openUrl / 可持久化地址，避免 blob 丢失 */
  imageUrl?: string;
  openUrl?: string;
  error?: string;
  createdAt: number;
  finishedAt?: number;
  resolution?: string;
  aspectRatio?: string;
  /** 服务端任务队列 id（VIP/站长后台任务） */
  serverTaskId?: string;
};

/** lines=每行一条 prompt；block=整段文本作为一条 prompt */
export type PromptMode = "lines" | "block";

export type StudioDraft = {
  promptText: string;
  aspectRatio: string;
  resolution: string;
  variants: number;
  concurrency: number;
  /** 新生成是否追加到结果墙；false=只保留本次 */
  appendResults: boolean;
  /** 失败后自动重试当前子任务，直到成功或用户停止 */
  autoRetry: boolean;
  /**
   * 后台任务：生成中可切页，关闭标签会提示。
   * 仅站长/VIP 可开启；UI 层按角色门禁。
   */
  backgroundTasks: boolean;
  /** 单行拆分 / 多行整段 */
  promptMode: PromptMode;
  /**
   * 参考图（图+文）：data URL / http(s) URL。
   * 仅会话内使用，不写入 localStorage（体积大）。
   */
  referenceImageUrl?: string;
  /** 参考图文件名，仅 UI 展示 */
  referenceImageName?: string;
};

// v2：清空旧版结果墙历史（v1 曾默认追加，容易看起来像「点一次出十几张」）
const JOBS_KEY = "ciallo-studio.jobs.v2";
const DRAFT_KEY = "ciallo-studio.draft.v2";
const MAX_JOBS = 120;
const LEGACY_KEYS = ["ciallo-studio.jobs.v1", "ciallo-studio.draft.v1"] as const;

export const VARIANT_OPTIONS = [1, 2, 3, 4, 5] as const;
/** 基础并发选项；第三档仅在用户组上限 >2 时出现 */
export const CONCURRENCY_OPTIONS = [1, 2] as const;

/**
 * 创作台并发按钮：最多 3 个。
 * - 上限 ≤1 → [1]
 * - 上限 =2 → [1, 2]
 * - 上限 >2 → [1, 2, 上限]（不展开中间值）
 */
export function concurrencyOptionsForCap(maxCap: number): number[] {
  const cap = Math.min(8, Math.max(1, Math.round(Number(maxCap)) || 2));
  if (cap <= 1) return [1];
  if (cap === 2) return [1, 2];
  return [1, 2, cap];
}
/** 默认每条 prompt 只出 1 张，避免用户以为选了 1:1 却生成 4 张 */
export const DEFAULT_VARIANTS = 1;

export function uid(prefix = ""): string {
  return `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function clampVariants(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_VARIANTS;
  return Math.min(5, Math.max(1, Math.round(value)));
}

/**
 * 每行一条 prompt；空行忽略。
 * 总张数 = 行数 × 生图数量 × 并发数。
 */
export function splitPrompts(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function normalizePromptMode(value: unknown): PromptMode {
  return value === "block" ? "block" : "lines";
}

/**
 * 按模式解析 prompt 列表。
 * - lines（单行）：每行一条，空行忽略（默认，与历史行为一致）
 * - block（多行）：整段 trim 后作为一条 prompt（保留内部换行）
 */
export function resolvePrompts(raw: string, mode: PromptMode = "lines"): string[] {
  if (normalizePromptMode(mode) === "block") {
    const text = String(raw ?? "").trim();
    return text ? [text] : [];
  }
  return splitPrompts(raw);
}

/**
 * 每条 prompt 最终展开几张：
 * 生图数量(variants) × 并发数(concurrency)
 */
export function imagesPerPrompt(variants: number, concurrency: number): number {
  return clampVariants(variants) * clampConcurrency(concurrency);
}

/**
 * 本次将生成的总张数：
 * Prompt 条数 × 生图数量 × 并发数
 */
export function planJobCount(
  prompts: string[] | string,
  variants: number,
  concurrency: number,
  mode: PromptMode = "lines",
): number {
  const list = Array.isArray(prompts) ? prompts : resolvePrompts(prompts, mode);
  return list.length * imagesPerPrompt(variants, concurrency);
}

/**
 * 展开任务队列。
 * 每条 prompt 生成 imagesPerPrompt = variants × concurrency 张；
 * 并发池 worker 数仍用 concurrency（同时跑几路）。
 */
export function expandJobs(
  prompts: string[],
  variants: number,
  concurrency: number,
  meta?: { resolution?: string; aspectRatio?: string },
): StudioJob[] {
  const count = imagesPerPrompt(variants, concurrency);
  const now = Date.now();
  const jobs: StudioJob[] = [];
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
        resolution: meta?.resolution,
        aspectRatio: meta?.aspectRatio,
      });
    }
  }
  return jobs;
}

/** 启动时清掉 v1 残留，避免旧结果墙/旧 draft 继续干扰 */
export function migrateLegacyStorage(): void {
  try {
    for (const key of LEGACY_KEYS) {
      localStorage.removeItem(key);
    }
  } catch {
    // ignore
  }
}

/** 只持久化可恢复字段，去掉 blob: */
function serializeJobs(jobs: StudioJob[]): StudioJob[] {
  return jobs.slice(0, MAX_JOBS).map((job) => {
    const openUrl = job.openUrl && !job.openUrl.startsWith("blob:") ? job.openUrl : undefined;
    let imageUrl = job.imageUrl;
    if (imageUrl?.startsWith("blob:")) {
      imageUrl = openUrl;
    }
    if (imageUrl?.startsWith("data:") && imageUrl.length > 200_000) {
      // 超大 data URL 不进 localStorage，避免配额爆掉
      imageUrl = openUrl;
    }
    const hasServerTask =
      typeof job.serverTaskId === "string" && job.serverTaskId.trim().length > 0;
    const inflight = job.status === "running" || job.status === "queued";
    // 浏览器队列：刷新无法续跑 → 标失败
    // 服务端队列：保留 queued/running + serverTaskId，重开页后可恢复轮询
    if (inflight && !hasServerTask) {
      return {
        ...job,
        imageUrl,
        openUrl,
        serverTaskId: undefined,
        status: "failed" as const,
        error: job.error || "页面刷新后未完成的任务已中断，可重新生成",
      };
    }
    return {
      ...job,
      imageUrl,
      openUrl,
      // 保留 serverTaskId，便于关页后续跑
      status: job.status,
      error: job.error,
    };
  });
}

export function loadJobs(): StudioJob[] {
  migrateLegacyStorage();
  try {
    const raw = localStorage.getItem(JOBS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StudioJob[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((j) => j && typeof j.id === "string" && typeof j.prompt === "string");
  } catch {
    return [];
  }
}

export function saveJobs(jobs: StudioJob[]): void {
  try {
    localStorage.setItem(JOBS_KEY, JSON.stringify(serializeJobs(jobs)));
  } catch (error) {
    // 配额不足时尝试只保留最近完成的图
    try {
      const slim = serializeJobs(jobs)
        .filter((j) => j.status === "done" || j.status === "failed")
        .slice(0, 40);
      localStorage.setItem(JOBS_KEY, JSON.stringify(slim));
    } catch {
      console.warn("[Ciallo] 无法持久化任务队列", error);
    }
  }
}

export function loadDraft(defaults: StudioDraft): StudioDraft {
  migrateLegacyStorage();
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) {
      return {
        ...defaults,
        variants: clampVariants(defaults.variants ?? DEFAULT_VARIANTS),
        concurrency: clampConcurrency(defaults.concurrency),
        appendResults: false,
        autoRetry: defaults.autoRetry === true,
        backgroundTasks: defaults.backgroundTasks === true,
        promptMode: normalizePromptMode(defaults.promptMode),
      };
    }
    const parsed = JSON.parse(raw) as Partial<StudioDraft>;
    return {
      promptText: typeof parsed.promptText === "string" ? parsed.promptText : defaults.promptText,
      aspectRatio: typeof parsed.aspectRatio === "string" ? parsed.aspectRatio : defaults.aspectRatio,
      resolution: typeof parsed.resolution === "string" ? parsed.resolution : defaults.resolution,
      variants: clampVariants(Number(parsed.variants ?? defaults.variants ?? DEFAULT_VARIANTS)),
      concurrency: clampConcurrency(Number(parsed.concurrency ?? defaults.concurrency)),
      // 缺省 / 非 boolean 一律 false：替换结果墙
      appendResults: parsed.appendResults === true,
      autoRetry: parsed.autoRetry === true,
      backgroundTasks: parsed.backgroundTasks === true,
      promptMode: normalizePromptMode(
        parsed.promptMode ?? defaults.promptMode ?? "lines",
      ),
    };
  } catch {
    return {
      ...defaults,
      variants: clampVariants(defaults.variants ?? DEFAULT_VARIANTS),
      concurrency: clampConcurrency(defaults.concurrency),
      appendResults: false,
      autoRetry: false,
      backgroundTasks: false,
      promptMode: normalizePromptMode(defaults.promptMode),
    };
  }
}

export function saveDraft(draft: StudioDraft): void {
  try {
    // 参考图可能是数 MB 的 data URL，禁止持久化以免撑爆 localStorage
    const { referenceImageUrl: _ref, referenceImageName: _name, ...rest } = draft;
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        ...rest,
        variants: clampVariants(draft.variants),
        concurrency: clampConcurrency(draft.concurrency),
        appendResults: draft.appendResults === true,
        autoRetry: draft.autoRetry === true,
        backgroundTasks: draft.backgroundTasks === true,
        promptMode: normalizePromptMode(draft.promptMode),
      }),
    );
  } catch {
    // ignore
  }
}

export function displayUrl(job: StudioJob | null | undefined): string | undefined {
  if (!job) return undefined;
  if (typeof job.imageUrl === "string" && job.imageUrl && !job.imageUrl.startsWith("blob:")) {
    return job.imageUrl;
  }
  if (typeof job.openUrl === "string" && job.openUrl) return job.openUrl;
  return typeof job.imageUrl === "string" ? job.imageUrl : undefined;
}
