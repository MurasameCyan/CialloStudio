import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [app, studioPage, hallPage, settingsPage, modeSwitch, main, graphite, adminQueue, ios26] =
  await Promise.all([
    readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/StudioPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/HallPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/SettingsPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/StudioModeSwitch.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/main.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles/graphite.css", import.meta.url), "utf8"),
    readFile(new URL("../src/components/AdminTaskQueuePanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles/ios26.css", import.meta.url), "utf8"),
  ]);

assert.match(app, /app-shell-\$\{tab\}/, "App 外壳应带当前页面作用域");
assert.match(app, /className="header-status"/, "头部应区分连接状态区");
assert.match(app, /className="header-controls"/, "头部应区分偏好控制区");
assert.match(modeSwitch, /studio-view-switch/, "顶栏工作台模式应有独立样式作用域");
assert.match(main, /\.\/styles\/graphite\.css/, "应用入口应加载 Graphite 样式");
assert.match(graphite, /\.app-shell-studio\s*\{/, "首页样式应限制在创作页作用域");
assert.match(graphite, /@media \(max-width: 720px\)/, "顶栏应有移动端断点");
assert.match(graphite, /@media \(hover: none\), \(pointer: coarse\)/, "触屏作品卡操作不应依赖 hover");
assert.match(studioPage, /studio-workbench/, "创作控制区应有语义作用域");
assert.match(studioPage, /studio-canvas/, "作品画布应有语义作用域");
assert.match(studioPage, /studio-generation-switch/, "生成类型切换应有独立样式作用域");
assert.equal(
  studioPage.match(/<PromptTemplateDialog/g)?.length,
  2,
  "控制台和对话模式都应挂载模板弹窗",
);

/* 大厅 / 管理：这两页的改造完全靠 .app-shell-{tab} 作用域挂钩，
   而 tab 值来自 App 的 `app-shell-${tab}` 模板串——三者任一改名都会让样式静默失效，
   页面退回未改造的样子且不报任何错。下面把这条链钉死。 */
for (const tab of ["studio", "hall", "settings"]) {
  assert.match(
    app,
    new RegExp(`"${tab}"`),
    `App 应存在 ${tab} 这个 tab 值，否则 .app-shell-${tab} 选不中任何元素`,
  );
  assert.match(graphite, new RegExp(`\\.app-shell-${tab}\\b`), `应有 ${tab} 页的作用域样式`);
}

/* 选择器命中的类必须真实渲染。CSS 写错类名不会报错，只会不生效。 */
for (const cls of ["hall-grid", "hall-card", "hall-head", "hall-search", "hall-drawer"]) {
  assert.match(graphite, new RegExp(`\\.app-shell-hall \\.${cls}\\b`), `大厅样式应覆盖 .${cls}`);
  assert.match(hallPage, new RegExp(`\\b${cls}\\b`), `HallPage 应渲染 .${cls}`);
}
for (const cls of ["admin-hero", "admin-section", "admin-block-label", "section-card-title"]) {
  assert.match(graphite, new RegExp(`\\.app-shell-settings \\.${cls}\\b`), `管理样式应覆盖 .${cls}`);
  assert.match(settingsPage, new RegExp(`\\b${cls}\\b`), `SettingsPage 应渲染 .${cls}`);
}

/* :81 的 `html[data-theme] .panel` 特异性 0-1-1-1，比 `.app-shell-hall .panel`(0-0-2-0) 高。
   不带 html[data-theme] 前缀这两页的面板背景会被基础样式吃回去。 */
for (const scope of ["hall", "settings"]) {
  assert.match(
    graphite,
    new RegExp(`html\\[data-theme\\] \\.app-shell-${scope} \\.panel\\b`),
    `${scope} 页 .panel 需带 html[data-theme] 前缀才压得过基础样式`,
  );
}

/* 大厅作品墙在窄屏必须收成单列，否则触屏上卡片操作区挤到无法点击。 */
assert.match(
  graphite,
  /@media \(max-width: 560px\)[^]*?\.app-shell-hall \.hall-grid \{\s*grid-template-columns: 1fr;/,
  "大厅作品墙在 560px 以下应收成单列",
);

/* 视频缩略图：<img src=".mp4"> 渲染出来是空白，队列列表必须按 kind 走 <video>。
   作品墙一直是对的（HallPage 有分支），坏的只有这两个队列列表。 */
for (const [name, src] of [
  ["StudioPage", studioPage],
  ["AdminTaskQueuePanel", adminQueue],
]) {
  assert.match(
    src,
    /kind === "video" \? \(\s*<video/,
    `${name} 队列缩略图应按 kind 渲染 <video>，否则视频预览是空白`,
  );
}
/* CSS 只写 img 的话 <video> 撑不出缩略图尺寸，等于换了个方式看不见。 */
for (const cls of ["studio-server-queue-thumb", "admin-task-thumb"]) {
  assert.match(
    ios26,
    new RegExp(`\\.${cls} img,\\s*\\.${cls} video \\{`),
    `.${cls} 的尺寸规则应同时覆盖 video`,
  );
}

/* 详情弹窗：视频也要能分享到大厅。这里曾写死 kind === "video" ? null，
   而 handleShareToHall / POST /posts / 大厅渲染早就支持视频了，只有这个门没开。 */
assert.doesNotMatch(
  studioPage,
  /previewJob\.kind === "video" \? null/,
  "详情弹窗不应屏蔽视频的分享按钮",
);
assert.match(studioPage, /previewShareLabel/, "详情弹窗应渲染分享按钮");

console.log("studio ui structure ok");
