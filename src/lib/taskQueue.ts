/**
 * 服务端任务队列客户端（VIP / 站长后台生图）
 * 浏览器 → /api/tasks/* → task-queue.mjs
 */
import { getToken } from "@/lib/community/client";

export type ServerTaskStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export type ServerTask = {
  id: string;
  ownerId: string;
  ownerName: string;
  status: ServerTaskStatus;
  prompt: string;
  model: string;
  baseUrl: string;
  /** image=生图；video=文生/图生视频 */
  kind?: "image" | "video";
  /** 视频时长（秒），仅 kind=video */
  duration?: number;
  aspectRatio: string;
  resolution: string;
  imageUrl?: string;
  autoRetry: boolean;
  attempt: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  batchId: string;
  variant: number;
  variants: number;
  clientJobId?: string;
  hasReference: boolean;
};

export type ServerQueueStats = {
  queuedCount: number;
  runningCount: number;
  doneCount: number;
  failedCount: number;
  concurrencyLimit: number;
  acceptingNewTasks: boolean;
  minePending?: number;
};

export type CreateServerTasksInput = {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** image=生图；video=文生/图生视频（服务端走 /videos/generations + 轮询） */
  kind?: "image" | "video";
  /** 视频时长（秒）：6 / 10 / 15，仅 kind=video */
  duration?: number;
  aspectRatio?: string;
  resolution?: string;
  autoRetry?: boolean;
  referenceImageUrl?: string;
  batchId?: string;
  /** 后台队列出图储存：site=改写 Site Base；media=上传 TG Worker */
  storageMode?: "media" | "site";
  /** 上游图片站公网根域名（只填 origin） */
  siteBase?: string;
  /** TG Worker 根域名（只填 origin） */
  mediaBase?: string;
  /** Worker 上传 token（可选，仅内存） */
  mediaUploadToken?: string;
  jobs: Array<{
    prompt: string;
    clientJobId?: string;
    variant?: number;
    variants?: number;
    batchId?: string;
  }>;
};

export class TaskQueueError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "TaskQueueError";
    this.status = status;
    this.code = code;
  }
}

const BASE = "/api/tasks";

async function taskHttp<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(`${BASE}${path.startsWith("/") ? path : `/${path}`}`, {
    ...init,
    headers,
  });
  let payload: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!res.ok) {
    const err =
      payload && typeof payload === "object" && payload !== null && "error" in payload
        ? (payload as { error?: { message?: string; code?: string } }).error
        : undefined;
    throw new TaskQueueError(
      res.status,
      err?.message || text.slice(0, 200) || `HTTP ${res.status}`,
      err?.code,
    );
  }
  return payload as T;
}

export async function createServerTasks(
  input: CreateServerTasksInput,
): Promise<{ batchId: string; tasks: ServerTask[]; stats: ServerQueueStats }> {
  return taskHttp("/tasks", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listServerTasks(options?: {
  status?: ServerTaskStatus;
  limit?: number;
}): Promise<{ items: ServerTask[]; stats: ServerQueueStats }> {
  const q = new URLSearchParams();
  if (options?.status) q.set("status", options.status);
  if (options?.limit) q.set("limit", String(options.limit));
  const suffix = q.toString() ? `?${q}` : "";
  return taskHttp(`/tasks${suffix}`);
}

export async function getServerTask(id: string): Promise<ServerTask> {
  return taskHttp(`/tasks/${encodeURIComponent(id)}`);
}

export async function cancelServerTask(id: string): Promise<ServerTask> {
  return taskHttp(`/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function cancelServerBatch(batchId: string): Promise<{ items: ServerTask[] }> {
  return taskHttp(`/batches/${encodeURIComponent(batchId)}/cancel`, { method: "POST" });
}

export type ServerQueueClearMode = "cancel_all" | "clear_failed" | "clear_all" | "clear_done";

export type ServerQueueClearResult = {
  mode: ServerQueueClearMode;
  cancelled?: number;
  removed?: number;
  items: ServerTask[];
  stats: ServerQueueStats;
};

/** 取消全部进行中 / 清除失败 / 清除全部 */
export async function clearServerTasks(
  mode: ServerQueueClearMode,
): Promise<ServerQueueClearResult> {
  if (mode === "cancel_all") {
    return taskHttp("/tasks/cancel-all", { method: "POST", body: "{}" });
  }
  return taskHttp("/tasks/clear", {
    method: "POST",
    body: JSON.stringify({ mode }),
  });
}

export async function getServerQueueStats(): Promise<ServerQueueStats> {
  return taskHttp("/stats");
}

/** 站长：全站后台任务分页列表 */
export type AdminTaskListResult = {
  items: ServerTask[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  byStatus: {
    queued: number;
    running: number;
    done: number;
    failed: number;
    cancelled: number;
  };
  stats: ServerQueueStats;
};

export async function listAdminServerTasks(options?: {
  status?: ServerTaskStatus;
  q?: string;
  limit?: number;
  offset?: number;
}): Promise<AdminTaskListResult> {
  const params = new URLSearchParams();
  if (options?.status) params.set("status", options.status);
  if (options?.q?.trim()) params.set("q", options.q.trim());
  if (options?.limit != null) params.set("limit", String(options.limit));
  if (options?.offset != null) params.set("offset", String(options.offset));
  const suffix = params.toString() ? `?${params}` : "";
  return taskHttp(`/admin/tasks${suffix}`);
}

export type AdminTaskClearResult = AdminTaskListResult & {
  mode: ServerQueueClearMode;
  cancelled?: number;
  removed?: number;
};

/** 站长：全站批量取消 / 清理 */
export async function clearAdminServerTasks(
  mode: ServerQueueClearMode,
): Promise<AdminTaskClearResult> {
  return taskHttp("/admin/tasks/clear", {
    method: "POST",
    body: JSON.stringify({ mode }),
  });
}

export function isServerTaskTerminal(status: ServerTaskStatus): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

/** 探测任务队列是否可用（未登录/非 VIP 会 401/403，仍说明服务在） */
export async function probeTaskQueue(): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${BASE}/healthz`, { headers: { Accept: "application/json" } });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const data = (await res.json()) as { ok?: boolean; service?: string };
    if (data?.ok) return { ok: true, detail: data.service || "task-queue" };
    return { ok: false, detail: "unexpected body" };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
