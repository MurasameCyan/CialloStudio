/**
 * 队列详情「详情」按钮：后台队列项 → StudioJob 的适配。
 *
 * 大图弹窗（含分享到大厅）吃的是 StudioJob，队列列表拿到的是 ServerQueueItem。
 * 适配时若丢了 kind，视频会被 <img> 渲染而放不出来；丢了 imageUrl/status
 * 则分享按钮直接 return。这里用源码结构断言把这些字段钉住。
 *
 * Run: node scripts/test-queue-preview-item.mjs
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const studio = await readFile(new URL("../src/components/StudioPage.tsx", import.meta.url), "utf8");
const hook = await readFile(new URL("../src/hooks/useStudioQueue.ts", import.meta.url), "utf8");

// —— 1. ServerQueueItem 必须带上预览所需字段 ——
const itemType = hook.slice(
  hook.indexOf("export type ServerQueueItem"),
  hook.indexOf("type QueueApi"),
);
assert.ok(itemType.length > 0, "未能定位 ServerQueueItem 类型");
for (const field of ["imageUrl", "kind", "duration", "aspectRatio", "resolution"]) {
  assert.ok(
    new RegExp(`\\b${field}\\??:`).test(itemType),
    `ServerQueueItem 缺 ${field}：大图预览/分享要用`,
  );
}

// —— 2. toServerQueueItem 必须真的透传这些字段 ——
const mapper = hook.slice(
  hook.indexOf("function toServerQueueItem"),
  hook.indexOf("const DEFAULT_PROMPT"),
);
assert.ok(mapper.length > 0, "未能定位 toServerQueueItem");
for (const field of ["imageUrl", "kind", "duration", "aspectRatio", "resolution"]) {
  assert.ok(
    mapper.includes(`${field}:`),
    `toServerQueueItem 没透传 ${field}：类型上有但值没带过来，等于没有`,
  );
}
assert.ok(
  /kind:\s*task\.kind === "video" \? "video" : "image"/.test(mapper),
  "kind 需归一成 image|video，缺省视作 image（与 ServerTask 注释一致）",
);

// —— 3. 队列项 → StudioJob 的适配函数 ——
const adapter = studio.slice(
  studio.indexOf("const handlePreviewServerItem"),
  studio.indexOf("const closePreview"),
);
assert.ok(adapter.length > 0, "未能定位 handlePreviewServerItem");
assert.ok(
  /item\.status !== "done"/.test(adapter) && /!item\.imageUrl/.test(adapter),
  "未完成或无图的队列项不该开弹窗（弹窗内分享也会因 status 校验直接 return）",
);
assert.ok(
  /openUrl:\s*item\.imageUrl/.test(adapter),
  "openUrl 要一并填上：displayUrl(job) 取不到时分享逻辑会回落到 job.openUrl",
);
assert.ok(
  /kind:\s*item\.kind === "video" \? "video" : "image"/.test(adapter),
  "适配时必须带 kind：丢了会把视频用 <img> 渲染",
);
assert.ok(
  /serverTaskId:\s*item\.id/.test(adapter),
  "保留 serverTaskId 以便回溯到后台任务",
);

// —— 4. 列表 UI：按钮文案是「详情」且走弹窗，不再直接跳转 ——
const listBlock = studio.slice(
  studio.indexOf('<ul className="studio-server-queue-list">'),
  studio.indexOf("const queueNoticeBanner"),
);
assert.ok(listBlock.length > 0, "未能定位队列详情列表");
assert.ok(listBlock.includes("详情"), "按钮文案应为「详情」");
assert.ok(
  !/打开<\/a>/.test(listBlock) && !/>\s*打开\s*</.test(listBlock),
  "不应再有直接跳转的「打开」按钮",
);
const thumbAndAction = listBlock.match(/handlePreviewServerItem\(item\)/g) || [];
assert.equal(
  thumbAndAction.length,
  2,
  `缩略图和「详情」按钮都应开弹窗（实际 ${thumbAndAction.length} 处）`,
);
assert.ok(
  !/className="studio-server-queue-thumb"[\s\S]{0,120}href=/.test(listBlock),
  "缩略图不该再是直接跳转的 <a href>，应为开弹窗的 button",
);

// —— 5. 弹窗本身仍提供分享入口（用户可选择是否分享）——
const lightbox = studio.slice(
  studio.indexOf('<div className="studio-lightbox-actions">'),
  studio.indexOf('if (mode === "chat")'),
);
assert.ok(lightbox.length > 0, "未能定位大图弹窗操作区");
assert.ok(
  lightbox.includes("handleShareToHall(previewJob)"),
  "弹窗必须保留分享到大厅入口——这是本次需求的核心：让用户自己选是否分享",
);
assert.ok(
  lightbox.includes("previewShareDisabled"),
  "分享按钮需保留已分享/冷却态的禁用判断",
);

console.log("PASS: queue detail opens lightbox with share option (5 groups)");
