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
};

export type StudioDraft = {
  promptText: string;
  aspectRatio: string;
  resolution: string;
  variants: number;
  concurrency: number;
};

const JOBS_KEY = "ciallo-studio.jobs.v1";
const DRAFT_KEY = "ciallo-studio.draft.v1";
const MAX_JOBS = 120;

export const VARIANT_OPTIONS = [1, 2, 3, 4, 6, 8] as const;
export const CONCURRENCY_OPTIONS = [1, 2, 3, 4, 6, 8] as const;

export function uid(prefix = ""): string {
  return `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function clampVariants(value: number): number {
  if (!Number.isFinite(value)) return 4;
  return Math.min(8, Math.max(1, Math.round(value)));
}

export function splitPrompts(raw: string): string[] {
  return raw
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function expandJobs(
  prompts: string[],
  variants: number,
  meta?: { resolution?: string; aspectRatio?: string },
): StudioJob[] {
  const count = clampVariants(variants);
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
    return {
      ...job,
      imageUrl,
      openUrl,
      // 刷新后进行中的任务无法续跑，标记为失败提示
      status: job.status === "running" || job.status === "queued" ? "failed" : job.status,
      error:
        job.status === "running" || job.status === "queued"
          ? job.error || "页面刷新后未完成的任务已中断，可重新生成"
          : job.error,
    };
  });
}

export function loadJobs(): StudioJob[] {
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
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) {
      return {
        ...defaults,
        variants: clampVariants(defaults.variants),
        concurrency: clampConcurrency(defaults.concurrency),
      };
    }
    const parsed = JSON.parse(raw) as Partial<StudioDraft>;
    return {
      promptText: typeof parsed.promptText === "string" ? parsed.promptText : defaults.promptText,
      aspectRatio: typeof parsed.aspectRatio === "string" ? parsed.aspectRatio : defaults.aspectRatio,
      resolution: typeof parsed.resolution === "string" ? parsed.resolution : defaults.resolution,
      variants: clampVariants(Number(parsed.variants ?? defaults.variants)),
      concurrency: clampConcurrency(Number(parsed.concurrency ?? defaults.concurrency)),
    };
  } catch {
    return {
      ...defaults,
      variants: clampVariants(defaults.variants),
      concurrency: clampConcurrency(defaults.concurrency),
    };
  }
}

export function saveDraft(draft: StudioDraft): void {
  try {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        ...draft,
        variants: clampVariants(draft.variants),
        concurrency: clampConcurrency(draft.concurrency),
      }),
    );
  } catch {
    // ignore
  }
}

export function displayUrl(job: StudioJob): string | undefined {
  if (job.imageUrl && !job.imageUrl.startsWith("blob:")) return job.imageUrl;
  if (job.openUrl) return job.openUrl;
  return job.imageUrl;
}
