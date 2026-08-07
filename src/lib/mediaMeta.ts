/**
 * 实际产物参数：宽高比 / 分辨率 / 时长。
 *
 * 「实际」= 从已加载的 <img>/<video> 元素量出来的真实尺寸，不是下单时选的参数。
 * 只展示媒体本身返回的参数，不混入下单时选择的参数。
 */

/** 量出来的产物尺寸；duration 仅视频有 */
export type MediaMeta = {
  width: number;
  height: number;
  duration?: number;
};

/** 面板里可选的宽高比，量出来的比例对不上整数比时吸附到最近的一档 */
const COMMON_RATIOS: ReadonlyArray<readonly [string, number]> = [
  ["1:1", 1],
  ["16:9", 16 / 9],
  ["9:16", 9 / 16],
  ["4:3", 4 / 3],
  ["3:4", 3 / 4],
  ["3:2", 3 / 2],
  ["2:3", 2 / 3],
];

/** 吸附容差：相对误差 2% 内认为就是这一档
 * （1792×1024 距精确 16:9 差 1.56%，仍应显示 16:9 而不是 7:4） */
const RATIO_TOLERANCE = 0.02;

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function validSize(width: number, height: number): boolean {
  return (
    Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
  );
}

/**
 * 宽高比标签。优先吸附到常见档位，否则用最简整数比；
 * 约不到小数字（比如 1023:1024）时退回两位小数的 w:h。
 */
export function formatAspectRatio(width: number, height: number): string | undefined {
  if (!validSize(width, height)) return undefined;
  const ratio = width / height;
  for (const [label, value] of COMMON_RATIOS) {
    if (Math.abs(ratio - value) / value <= RATIO_TOLERANCE) return label;
  }
  const w = Math.round(width);
  const h = Math.round(height);
  const divisor = gcd(w, h) || 1;
  const rw = w / divisor;
  const rh = h / divisor;
  if (rw <= 50 && rh <= 50) return `${rw}:${rh}`;
  return ratio >= 1 ? `${(ratio).toFixed(2)}:1` : `1:${(1 / ratio).toFixed(2)}`;
}

/** 像素尺寸，例如 1024×1024 */
export function formatResolution(width: number, height: number): string | undefined {
  if (!validSize(width, height)) return undefined;
  return `${Math.round(width)}×${Math.round(height)}`;
}

/**
 * 分辨率档位，按最长边归到 1k / 2k —— 与面板上的分辨率按钮同一套说法。
 * 视频档位（480p/720p/1080p）按高度算，走 videoTier。
 */
export function resolutionTier(width: number, height: number): string | undefined {
  if (!validSize(width, height)) return undefined;
  const longest = Math.max(width, height);
  return `${Math.max(1, Math.round(longest / 1024))}k`;
}

/** 视频档位：按较短边归到 480p / 720p / 1080p */
export function videoTier(width: number, height: number): string | undefined {
  if (!validSize(width, height)) return undefined;
  const shortest = Math.min(width, height);
  const steps = [480, 720, 1080, 1440, 2160];
  let best = steps[0];
  for (const step of steps) {
    if (Math.abs(shortest - step) < Math.abs(shortest - best)) best = step;
  }
  return `${best}p`;
}

/** 时长：<60s 显示 6s，否则 1:05 */
export function formatDuration(seconds: number | undefined): string | undefined {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${min}:${String(sec).padStart(2, "0")}`;
}

/**
 * 卡片/预览上要显示的参数标签，按 宽高比 · 分辨率 · 时长 排列。
 * video=true 时分辨率用 480p 这类档位，图片用 1k/2k。
 */
export function describeMediaMeta(
  meta: MediaMeta | undefined,
  video = false,
): string[] {
  if (!meta) return [];
  const chips: string[] = [];
  const ratio = formatAspectRatio(meta.width, meta.height);
  if (ratio) chips.push(ratio);
  const pixels = formatResolution(meta.width, meta.height);
  const tier = video ? videoTier(meta.width, meta.height) : resolutionTier(meta.width, meta.height);
  if (pixels) chips.push(tier ? `${pixels} · ${tier}` : pixels);
  const duration = formatDuration(meta.duration);
  if (duration) chips.push(duration);
  return chips;
}
