import type { StudioJob } from "./studioQueue";
import { displayUrl } from "./studioQueue";

function safeFilePart(text: string, max = 36): string {
  const cleaned = text
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (cleaned || "image").slice(0, max);
}

export function jobFileName(job: StudioJob, index?: number): string {
  const prompt = safeFilePart(job.prompt);
  const res = job.resolution ? `_${job.resolution}` : "";
  const n = typeof index === "number" ? `_${String(index + 1).padStart(2, "0")}` : `_${job.variant}`;
  return `ciallo${n}_${prompt}${res}.jpg`;
}

async function blobFromUrl(url: string, apiKey?: string): Promise<Blob> {
  if (url.startsWith("data:")) {
    const res = await fetch(url);
    return res.blob();
  }

  const headers = new Headers({ Accept: "image/*,*/*" });
  if (apiKey?.trim()) {
    headers.set("Authorization", `Bearer ${apiKey.trim()}`);
  }

  const response = await fetch(url, { method: "GET", headers });
  if (!response.ok) {
    throw new Error(`下载失败 HTTP ${response.status}`);
  }
  return response.blob();
}

function triggerSave(blob: Blob, fileName: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
}

export async function downloadJobs(
  jobs: StudioJob[],
  options?: {
    apiKey?: string;
    onProgress?: (done: number, total: number, job: StudioJob) => void;
  },
): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;
  const total = jobs.length;

  for (let i = 0; i < jobs.length; i += 1) {
    const job = jobs[i];
    const src = displayUrl(job) || job.openUrl;
    if (!src) {
      failed += 1;
      options?.onProgress?.(i + 1, total, job);
      continue;
    }
    try {
      const blob = await blobFromUrl(src, options?.apiKey);
      triggerSave(blob, jobFileName(job, i));
      ok += 1;
      // 避免浏览器拦截连续下载
      if (i < jobs.length - 1) {
        await new Promise((r) => setTimeout(r, 280));
      }
    } catch {
      failed += 1;
    }
    options?.onProgress?.(i + 1, total, job);
  }

  return { ok, failed };
}
