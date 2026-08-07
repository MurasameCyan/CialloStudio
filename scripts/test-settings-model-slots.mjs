/**
 * 模型槽语义：图生图 / 视频模型为空 = 该功能未启用。
 * 直接跑 TS 源（node --experimental-strip-types），避免像旧测试那样复制一份 JS 逻辑再漂移。
 * Run: node --experimental-strip-types scripts/test-settings-model-slots.mjs
 */
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  SOURCE_ASPECT_RATIO,
  closestAspectRatio,
  loadSettings,
  normalizeSettings,
  resolveGenerationAspectRatio,
  resolvePromptOptimizeEndpoint,
} from "../src/lib/settings.ts";
import { getImageModelCapability, resolveGenerationTarget } from "../src/lib/imageModels.ts";

// —— normalizeSettings ——
{
  const d = normalizeSettings({});
  assert.equal(d.model, DEFAULT_SETTINGS.model, "文生图模型有默认值");
  assert.equal(d.imageEditModel, "", "图生图模型默认空 = 未启用");
  assert.equal(d.videoModel, "", "视频模型默认空 = 未启用");
  assert.equal(d.videoResolution, "720p");
  assert.equal(d.videoDuration, 6);

  // 空槽不该被填上默认模型，否则功能会被意外打开
  const blank = normalizeSettings({ imageEditModel: "   ", videoModel: "  " });
  assert.equal(blank.imageEditModel, "", "空白图生图模型收敛为空");
  assert.equal(blank.videoModel, "", "空白视频模型收敛为空");

  // 白名单钳制
  assert.equal(normalizeSettings({ videoDuration: 9 }).videoDuration, 10, "9s 就近取 10s");
  assert.equal(normalizeSettings({ videoDuration: "oops" }).videoDuration, 6, "NaN 时长回落 6s");
  assert.equal(normalizeSettings({ videoResolution: "4K" }).videoResolution, "720p", "非法分辨率回落");
  assert.equal(normalizeSettings({ resolution: "4k" }).resolution, "1k", "图片分辨率只有 1k/2k");
  assert.equal(normalizeSettings({ resolution: "2k" }).resolution, "2k", "2k 是合法图片分辨率");
}

// —— 参考图“源”宽高比：映射到图生图/视频共同支持的最近档位 ——
{
  assert.equal(closestAspectRatio(1920, 1080), "16:9");
  assert.equal(closestAspectRatio(1080, 1920), "9:16");
  assert.equal(closestAspectRatio(1200, 1000), "4:3", "6:5 就近映射 4:3");
  assert.equal(closestAspectRatio(1000, 1200), "3:4", "5:6 就近映射 3:4");
  assert.equal(closestAspectRatio(2000, 1000), "16:9", "2:1 映射最接近的受支持比例");
  assert.equal(closestAspectRatio(0, 1000), undefined, "无效尺寸不解析");
  assert.equal(resolveGenerationAspectRatio(SOURCE_ASPECT_RATIO, 1500, 1000), "3:2");
  assert.equal(resolveGenerationAspectRatio("1:1", 1920, 1080), "1:1", "手选比例保持不变");
}

// —— 未选择时的默认模型 ——
{
  assert.equal(DEFAULT_SETTINGS.model, "grok-imagine-image-lite", "文生图默认模型");
  assert.equal(DEFAULT_SETTINGS.imageEditModel, "grok-imagine-image-quality", "图生图默认模型");
  assert.equal(DEFAULT_SETTINGS.videoModel, "grok-imagine-video", "视频默认模型");
  assert.equal(DEFAULT_SETTINGS.promptOptimizeModel, "grok-4.5", "提示词默认模型");
}

// —— 提示词优化统一复用生图上游（独立上游已移除）——
{
  const ep = resolvePromptOptimizeEndpoint(
    normalizeSettings({ baseUrl: "https://x/v1", apiKey: "g2a_x", promptOptimizeModel: "grok-4.5" }),
  );
  assert.equal(ep.baseUrl, "https://x/v1", "优化走生图 Base");
  assert.equal(ep.apiKey, "g2a_x", "优化走生图 Key");
  assert.equal(ep.model, "grok-4.5");
  assert.equal("usingCustomUpstream" in ep, false, "独立上游字段已彻底移除");
}

// —— 图片分辨率能力：现在所有图片模型都可选 2k ——
{
  for (const id of [
    "grok-imagine-image-lite",
    "grok-imagine-image",
    "grok-imagine-image-quality",
    "grok-imagine-image-edit",
  ]) {
    const cap = getImageModelCapability(id);
    assert.ok(cap.allowedResolutions.includes("2k"), `${id} 应允许 2k`);
    assert.ok(cap.allowedResolutions.includes("1k"), `${id} 应允许 1k`);
  }
}

// —— resolveGenerationTarget ——
const IMG = "grok-imagine-image";
const EDIT = "grok-imagine-image-edit";
const VID = "grok-imagine-video";
const target = (over) =>
  resolveGenerationTarget({ model: IMG, imageEditModel: "", videoModel: "", videoMode: false, ...over });

{
  // 没配图生图模型：参考图被忽略，仍走文生图
  const t = target({ referenceImageUrl: "data:image/png;base64,AAA" });
  assert.equal(t.model, IMG);
  assert.equal(t.referenceUrl, undefined, "未启用图生图时忽略参考图");
  assert.equal(t.error, undefined);

  // 配了图生图模型 + 有参考图 → 换模型走 /images/edits
  const edit = target({ imageEditModel: EDIT, referenceImageUrl: "https://x/y.png" });
  assert.equal(edit.model, EDIT, "带参考图时切到图生图模型");
  assert.equal(edit.referenceUrl, "https://x/y.png");

  // 配了图生图模型但没传图 → 退化为纯文生图，不报错
  const noRef = target({ imageEditModel: EDIT });
  assert.equal(noRef.model, IMG, "没参考图时仍用文生图模型");
  assert.equal(noRef.error, undefined);

  // 文生图槽里直接填了编辑类模型 → 参考图必填
  const forced = target({ model: EDIT });
  assert.equal(forced.error?.code, "missing_reference_image", "编辑类模型缺图必须判错");

  // 视频模式：用视频模型，参考图当首帧且可空
  const v = target({ videoMode: true, videoModel: VID, model: EDIT });
  assert.equal(v.model, VID, "视频模式不受图片模型影响");
  assert.equal(v.error, undefined, "视频模式不强制参考图");
  const vRef = target({ videoMode: true, videoModel: VID, referenceImageUrl: "https://x/first.png" });
  assert.equal(vRef.referenceUrl, "https://x/first.png", "视频首帧透传");
}

console.log("settings model slots ok: 空槽=未启用，参考图按 imageEditModel 决策");

// —— 旧版「开关 + 模型」两段式配置的迁移 ——
// 旧 saveSettings 无论开关状态都写死 videoModel，所以不迁移的话老用户视频模式会凭空打开。
{
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const KEY = "ciallo-studio.settings.v1";
  const legacy = (over) =>
    JSON.stringify({
      baseUrl: "https://x/v1",
      apiKey: "g2a_x",
      model: "grok-imagine-image",
      videoEnabled: false,
      videoModel: "grok-imagine-video",
      imageToImageEnabled: false,
      ...over,
    });

  store.set(KEY, legacy());
  const off = loadSettings();
  assert.equal(off.videoModel, "", "旧版视频开关为关 → 视频槽必须清空");
  assert.equal(off.imageEditModel, "", "旧版图生图开关为关 → 图生图槽为空");
  assert.equal(off.model, "grok-imagine-image", "文生图模型不受迁移影响");

  store.set(KEY, legacy({ videoEnabled: true }));
  assert.equal(loadSettings().videoModel, "grok-imagine-video", "旧版视频开关为开 → 保留原模型");

  // 新版存档不再有 videoEnabled，迁移不该再命中
  store.set(KEY, JSON.stringify({ videoModel: "grok-imagine-video", imageEditModel: "edit-x" }));
  const fresh = loadSettings();
  assert.equal(fresh.videoModel, "grok-imagine-video", "新版存档的视频槽保持不动");
  assert.equal(fresh.imageEditModel, "edit-x", "新版存档的图生图槽保持不动");

  delete globalThis.localStorage;
}

console.log("legacy toggle migration ok: 旧开关关 → 槽清空，新存档不受影响");
