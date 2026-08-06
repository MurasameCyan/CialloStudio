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

  // 图+文编辑模型（grok2api /images/edits）
  if (isImageEditModel(id)) {
    return {
      id,
      label: "Image Edit",
      supportsResolution: true,
      allowedResolutions: ["1k", "2k"],
      note: "图生图编辑模型：需参考图 + 提示词，走 /images/edits。",
    };
  }

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

/**
 * 是否支持图+文参考图输入（grok2api: POST /images/edits）。
 * 仅编辑类模型显示参考图上传区，如 grok-imagine-image-edit。
 */
export function isImageEditModel(model: string): boolean {
  const id = model.trim().toLowerCase();
  if (!id) return false;
  if (id === "grok-imagine-image-edit") return true;
  // 兼容带前缀/后缀的 edit 图片模型 id
  if (/imagine.*image.*edit|image.*edit|img.?edit/i.test(id)) return true;
  return false;
}

/**
 * 解析本次生成用哪个模型、要不要带参考图。
 * 管理页的三个模型槽就是开关：填了图生图/视频模型才有对应能力。
 * - 视频模式：用视频模型，参考图当首帧（可空）
 * - 有参考图 + 配了图生图模型：换成图生图模型走 /images/edits
 * - 文生图槽里填的就是编辑类模型：参考图必填（上游 /images/edits 必须有图）
 * - 其余情况忽略草稿里的参考图，避免误带进文生图请求
 */
export function resolveGenerationTarget(input: {
  model: string;
  imageEditModel: string;
  videoModel: string;
  videoMode: boolean;
  referenceImageUrl?: string;
}): { model: string; referenceUrl?: string; error?: { message: string; code: string } } {
  const trim = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const ref = trim(input.referenceImageUrl);
  if (input.videoMode) {
    return { model: trim(input.videoModel), referenceUrl: ref || undefined };
  }

  const editModel = trim(input.imageEditModel);
  const usingEdit = Boolean(ref && editModel);
  const model = usingEdit ? editModel : trim(input.model);

  if (isImageEditModel(model) && !ref) {
    return {
      model,
      error: { message: "当前为图生图模型，请先上传参考图", code: "missing_reference_image" },
    };
  }
  if (!usingEdit && !isImageEditModel(model)) return { model };
  return { model, referenceUrl: ref || undefined };
}

export function normalizeResolutionForModel(model: string, resolution: string): ResolutionOption {
  const cap = getImageModelCapability(model);
  const value = resolution.trim().toLowerCase() as ResolutionOption;
  if (cap.allowedResolutions.includes(value)) return value;
  return cap.allowedResolutions[0] ?? "1k";
}
