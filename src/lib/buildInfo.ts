/**
 * Local build id + optional GitHub update check.
 *
 * Pattern aligned with GrokRegisterAgent / ciallo-ms365 updateCheck:
 * - Display BUILD_ID as git short SHA
 * - Resolve: runtime-config → Vite define → package version fallback
 * - Update check only on user click; compare short SHA against branch HEAD
 */

export type BuildInfo = {
  hash: string;
  full: string;
  buildId: string;
  repoUrl: string;
  commitUrl: string;
  trackRef: string;
  githubRepo: string;
};

export type UpdateCheckResult = {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  htmlUrl: string;
  publishedAt: string | null;
  buildId: string;
  error: string | null;
};

const DEFAULT_REPO = "MurasameCyan/CialloStudio";
const DEFAULT_REF = "beta";
const SHA_RE = /^[0-9a-fA-F]{7,40}$/;

/** Injected at Vite build/dev time (see vite.config.ts / vite-env.d.ts). */

export function shortSha(raw: string): string {
  const text = (raw || "").trim().split(/\s+/)[0] || "";
  if (!text) return "";
  if (["unknown", "null", "none", "n/a"].includes(text.toLowerCase())) return "";
  if (SHA_RE.test(text)) return text.slice(0, 7).toLowerCase();
  return text.slice(0, 32);
}

function normalizeRepoSlug(raw: string): string {
  let s = (raw || "").trim();
  if (s.startsWith("https://github.com/")) {
    s = s.replace(/^https:\/\/github\.com\//, "").replace(/\/+$/, "");
  }
  if (s.startsWith("git@github.com:")) {
    s = s.replace(/^git@github\.com:/, "").replace(/\.git$/, "");
  }
  s = s.replace(/\.git$/, "");
  return s || DEFAULT_REPO;
}

function readRuntimeBuild(): { buildId: string; githubRepo: string; trackRef: string } {
  const raw = typeof window !== "undefined" ? window.__CIALLO_RUNTIME__ : undefined;
  const buildId =
    typeof raw?.buildId === "string" ? shortSha(raw.buildId) || raw.buildId.trim() : "";
  const githubRepo =
    typeof raw?.githubRepo === "string" && raw.githubRepo.trim()
      ? normalizeRepoSlug(raw.githubRepo)
      : "";
  const trackRef =
    typeof raw?.trackRef === "string" && raw.trackRef.trim() ? raw.trackRef.trim() : "";
  return { buildId, githubRepo, trackRef };
}

function bakedBuildId(): string {
  try {
    if (typeof __CIALLO_BUILD_ID__ === "string" && __CIALLO_BUILD_ID__.trim()) {
      return shortSha(__CIALLO_BUILD_ID__) || __CIALLO_BUILD_ID__.trim();
    }
  } catch {
    /* define missing in some test runners */
  }
  return "";
}

function bakedTrackRef(): string {
  try {
    if (typeof __CIALLO_TRACK_REF__ === "string" && __CIALLO_TRACK_REF__.trim()) {
      return __CIALLO_TRACK_REF__.trim();
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_REF;
}

function bakedGithubRepo(): string {
  try {
    if (typeof __CIALLO_GITHUB_REPO__ === "string" && __CIALLO_GITHUB_REPO__.trim()) {
      return normalizeRepoSlug(__CIALLO_GITHUB_REPO__);
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_REPO;
}

/** Resolve current runtime BUILD_ID (short hash preferred). */
export function currentBuildId(): string {
  const rt = readRuntimeBuild();
  return shortSha(rt.buildId) || shortSha(bakedBuildId()) || "unknown";
}

/** Display fields for Settings / about UI. */
export function resolveBuildInfo(): BuildInfo {
  const rt = readRuntimeBuild();
  const fullCandidate = (rt.buildId || bakedBuildId() || "").trim();
  const full = SHA_RE.test(fullCandidate) ? fullCandidate.toLowerCase() : shortSha(fullCandidate);
  const build = currentBuildId();
  const short = shortSha(build) || build;
  const githubRepo = rt.githubRepo || bakedGithubRepo();
  const trackRef = rt.trackRef || bakedTrackRef();
  const repoUrl = `https://github.com/${githubRepo}`;
  const commitUrl =
    full && SHA_RE.test(full)
      ? `${repoUrl}/commit/${full}`
      : `${repoUrl}/commits/${trackRef}`;

  return {
    hash: short !== "unknown" ? short : "n/a",
    full: full || (short !== "unknown" ? short : ""),
    buildId: short,
    repoUrl,
    commitUrl,
    trackRef,
    githubRepo,
  };
}

/**
 * Compare local BUILD_ID to GitHub track-ref HEAD (user-triggered only).
 * Uses public commits API — no token required for public repos.
 */
export async function checkForUpdate(
  fetchImpl: typeof fetch = fetch,
): Promise<UpdateCheckResult> {
  const info = resolveBuildInfo();
  const current = info.buildId !== "n/a" ? info.buildId : currentBuildId();
  const repo = info.githubRepo;
  const ref = info.trackRef;
  const base: UpdateCheckResult = {
    current,
    latest: null,
    hasUpdate: false,
    htmlUrl: `https://github.com/${repo}/commits/${ref}`,
    publishedAt: null,
    buildId: current,
    error: null,
  };

  const url = `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`;
  let resp: Response;
  try {
    resp = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "ciallo-studio",
      },
    });
  } catch (exc) {
    return { ...base, error: exc instanceof Error ? exc.message : String(exc) };
  }

  if (resp.status === 404) {
    return { ...base, error: `分支 ${ref} 不可用` };
  }
  if (resp.status >= 400) {
    return { ...base, error: `GitHub 返回 HTTP ${resp.status}` };
  }

  let data: {
    sha?: string;
    html_url?: string;
    commit?: {
      committer?: { date?: string };
      author?: { date?: string };
    };
  };
  try {
    data = (await resp.json()) as typeof data;
  } catch {
    return { ...base, error: "GitHub 返回非 JSON" };
  }

  const latestFull = String(data.sha || "").trim();
  const latest = shortSha(latestFull) || null;
  const localNorm = shortSha(current);
  const remoteNorm = latest || "";
  const bothHash = Boolean(SHA_RE.test(localNorm) && SHA_RE.test(remoteNorm));
  const hasUpdate = bothHash
    ? localNorm.toLowerCase() !== remoteNorm.toLowerCase()
    : Boolean(latest && latest !== current);

  const commitMeta = data.commit || {};
  const published =
    commitMeta.committer?.date || commitMeta.author?.date || null;

  return {
    current,
    latest,
    hasUpdate,
    htmlUrl: data.html_url || base.htmlUrl,
    publishedAt: published,
    buildId: current,
    error: null,
  };
}
