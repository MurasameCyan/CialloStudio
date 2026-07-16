/** 与 grok2api web catalog 对齐的图片模型能力说明 */

export type ResolutionOption = "1k" | "2k";

export type ImageModelCapability = {
  id: string;
  label: string;
  /** 是否会真正把 resolution 传给上游并生效 */
  supportsResolution: boolean;
  allowedResolutions: ResolutionOption[];
  note: string;
};

const CAPABILITIES: Record<string, ImageModelCapability> = {
  "grok-imagine-image": {
    id: "grok-imagine-image",
    label: "Fast（Lite）",
    supportsResolution: false,
    allowedResolutions: ["1k"],
    note: "快速模型（imagine-lite）会忽略 resolution，出图像素由上游固定，常见约 1K 级。",
  },
  "grok-imagine-image-quality": {
    id: "grok-imagine-image-quality",
    label: "Quality",
    supportsResolution: true,
    allowedResolutions: ["1k", "2k"],
    note: "高质量模型支持 1k / 2k。当前 grok2api 不支持 4k。",
  },
};

export function getImageModelCapability(model: string): ImageModelCapability {
  const id = model.trim();
  if (CAPABILITIES[id]) return CAPABILITIES[id];

  // 名称里带 quality / 非 lite 的 imagine 模型，按可调分辨率处理
  if (/imagine.*quality|quality.*imagine/i.test(id)) {
    return {
      id,
      label: "Quality-like",
      supportsResolution: true,
      allowedResolutions: ["1k", "2k"],
      note: "按高质量图片模型处理，支持 1k / 2k。",
    };
  }

  if (/imagine|image/i.test(id)) {
    return {
      id,
      label: "Image",
      supportsResolution: false,
      allowedResolutions: ["1k"],
      note: "未知图片模型：可能不支持 resolution。若尺寸不变，请换 quality 模型。",
    };
  }

  return {
    id,
    label: model || "未知",
    supportsResolution: false,
    allowedResolutions: ["1k"],
    note: "当前模型可能不是图片模型，或不支持分辨率参数。",
  };
}

export function normalizeResolutionForModel(model: string, resolution: string): ResolutionOption {
  const cap = getImageModelCapability(model);
  const value = resolution.trim().toLowerCase() as ResolutionOption;
  if (cap.allowedResolutions.includes(value)) return value;
  return cap.allowedResolutions[0] ?? "1k";
}
