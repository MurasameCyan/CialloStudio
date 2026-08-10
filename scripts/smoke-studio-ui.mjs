// 创作台 / 大厅 / 管理响应式浏览器 smoke。不在 test:unit 里——它需要两个外部前置条件：
//   1) npm run dev（127.0.0.1:5173）
//   2) chrome --headless=new --remote-debugging-port=9223 --user-data-dir=<临时目录>
// 跑法：npm run test:ui-smoke
// 脚本会拦掉 runtime-config.js 换成 communityMode=mock，所以不需要社区后端。
import assert from "node:assert/strict";

const DEBUG_PORT = 9223;
const APP_URL = "http://127.0.0.1:5173/";

async function openTarget() {
  // 开空白页：runtime-config.js 的拦截器必须在首次导航前装好
  const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent("about:blank")}`, {
    method: "PUT",
  });
  assert.equal(response.ok, true, `无法创建 Chrome 调试页：${response.status}`);
  return response.json();
}

async function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });

  function send(method, params = {}) {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }

  return { socket, send };
}

async function waitFor(send, expression, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.result?.value) return result.result.value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待页面条件超时：${expression}`);
}

const target = await openTarget();
const { socket, send } = await connect(target.webSocketDebuggerUrl);
const consoleErrors = [];
await send("Runtime.enable");
await send("Page.enable");
await send("Console.enable");
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.method === "Runtime.exceptionThrown") {
    consoleErrors.push(message.params.exceptionDetails.text);
  }
  if (message.method === "Console.messageAdded" && message.params.message.level === "error") {
    consoleErrors.push(message.params.message.text);
  }
  // 把 runtime-config.js 换成 mock 模式：dev 下没有社区后端，走 http 会让大厅/管理
  // 全线 HTTP 500，管理页更是登录不进去（App.tsx:144 未登录直接踢回大厅）。
  // 只能替换响应体——addScriptToEvaluateOnNewDocument 会被这个文件整体覆盖掉。
  if (message.method === "Fetch.requestPaused") {
    void send("Fetch.fulfillRequest", {
      requestId: message.params.requestId,
      responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "application/javascript" }],
      body: Buffer.from(
        `window.__CIALLO_RUNTIME__ = { masterUsername: "", masterPasswordSha256: "", mediaBase: "", mediaUploadToken: "", siteBase: "", queueStorageMode: "", communityMode: "mock", communityApiBase: "/api/community", buildId: "", githubRepo: "MurasameCyan/CialloStudio", trackRef: "beta", promptTemplatesUrl: "" };`,
      ).toString("base64"),
    });
  }
});

await send("Fetch.enable", {
  patterns: [{ urlPattern: "*runtime-config.js*", requestStage: "Response" }],
});
await send("Page.navigate", { url: APP_URL });

await waitFor(send, `document.querySelector('.studio-workbench') && document.readyState === 'complete'`);
for (const width of [390, 560, 720, 940, 1440]) {
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height: 900,
    deviceScaleFactor: 1,
    mobile: width <= 560,
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  const result = await send("Runtime.evaluate", {
    expression: `(() => {
      const root = document.documentElement;
      const overflow = Math.max(root.scrollWidth, document.body.scrollWidth) - root.clientWidth;
      return {
        width: root.clientWidth,
        scrollWidth: Math.max(root.scrollWidth, document.body.scrollWidth),
        overflow,
        headerRight: Math.ceil(document.querySelector('.app-header').getBoundingClientRect().right),
        viewport: innerWidth,
      };
    })()`,
    returnByValue: true,
  });
  const metrics = result.result.value;
  assert.ok(metrics.overflow <= 1, `${width}px 存在 ${metrics.overflow}px 横向溢出：${JSON.stringify(metrics)}`);
  assert.ok(metrics.headerRight <= metrics.viewport + 1, `${width}px 顶栏超出视口：${JSON.stringify(metrics)}`);
}

await send("Emulation.setDeviceMetricsOverride", {
  width: 390,
  height: 900,
  deviceScaleFactor: 1,
  mobile: true,
});
await waitFor(send, `Boolean(document.querySelector('.studio-canvas'))`);
// 空作品墙不渲染 .gallery/.card，注入探针节点直接量真实级联结果
const mobileStyles = await send("Runtime.evaluate", {
  expression: `(() => {
    const probe = document.createElement('div');
    probe.className = 'gallery';
    probe.innerHTML = '<div class="card"><div class="card-overlay"></div></div>';
    document.querySelector('.studio-canvas').appendChild(probe);
    const gallery = getComputedStyle(probe);
    const overlay = getComputedStyle(probe.querySelector('.card-overlay'));
    const styles = {
      columns: gallery.gridTemplateColumns,
      overlayPosition: overlay.position,
      overlayOpacity: overlay.opacity,
    };
    probe.remove();
    return styles;
  })()`,
  returnByValue: true,
});
const mobile = mobileStyles.result.value;
assert.ok(!mobile.columns.includes(" "), `390px 作品墙应为单列，实际 ${mobile.columns}`);
// 触屏没有 hover，卡片操作必须常驻可见
assert.equal(mobile.overlayPosition, "static", "390px 卡片操作条应常驻而非绝对定位覆盖");
assert.equal(mobile.overlayOpacity, "1", "390px 卡片操作条不应依赖 hover 才显示");

// 「开始生成 · N」是单个字符串，· 前的空格在窄容器里会折成两行。
// 量实际高度与行高的比值，比断言 white-space 更贴近用户看到的结果。
const generateButton = await send("Runtime.evaluate", {
  expression: `(() => {
    const btn = [...document.querySelectorAll('.studio-toolbar-actions .btn')]
      .find((node) => /^(开始生成|入队生成|入队)\\s·/.test(node.textContent.trim()));
    if (!btn) return null;
    const style = getComputedStyle(btn);
    // 按钮有 min-height，不能用 clientHeight 反推行数。
    // Range 量文本节点的实际渲染矩形，一行文字只会产生一个 rect。
    const range = document.createRange();
    range.selectNodeContents(btn);
    return {
      text: btn.textContent.trim(),
      whiteSpace: style.whiteSpace,
      lines: range.getClientRects().length,
    };
  })()`,
  returnByValue: true,
});
const genBtn = generateButton.result.value;
if (genBtn) {
  assert.equal(
    genBtn.whiteSpace,
    "nowrap",
    `390px「${genBtn.text}」按钮应禁止换行，实际 white-space: ${genBtn.whiteSpace}`,
  );
  assert.ok(
    genBtn.lines <= 1,
    `390px「${genBtn.text}」按钮应单行显示，实测占 ${genBtn.lines} 行`,
  );
}

const templateButton = await send("Runtime.evaluate", {
  expression: `(() => {
    const button = [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === '模板');
    if (!button) return false;
    button.click();
    return true;
  })()`,
  returnByValue: true,
});
assert.equal(templateButton.result.value, true, "创作台应存在模板按钮");
await waitFor(send, `Boolean(document.querySelector('[role="dialog"][aria-label="提示词模板"]'))`);

// 关掉弹窗，避免它挡住后面要点的导航
await send("Runtime.evaluate", {
  expression: `document.querySelector('[role="dialog"][aria-label="提示词模板"] .tpl-close')?.click()`,
});

// 登录站长：管理页要求登录态，未登录点「管理」会被踢回大厅（App.tsx:144）。
// mock 模式自带 admin/admin123 种子（mockStore.ts:65）。
// 会话持久化在 localStorage，复用同一个 Chrome profile 时可能已经登录——
// 所以这一段必须幂等：已登录就跳过表单。
await send("Runtime.evaluate", {
  expression: `[...document.querySelectorAll('.nav-pills .nav-pill')].find((n) => n.textContent.trim() === '大厅')?.click()`,
});
await waitFor(send, `Boolean(document.querySelector('.app-shell-hall'))`);

const loggedIn = await send("Runtime.evaluate", {
  expression: `[...document.querySelectorAll('.nav-pills .nav-pill')].some((n) => n.textContent.trim() === '管理')`,
  returnByValue: true,
});
if (!loggedIn.result.value) {
  await send("Runtime.evaluate", {
    expression: `[...document.querySelectorAll('button')].find((n) => n.textContent.trim() === '登录 / 注册')?.click()`,
  });
  await waitFor(send, `Boolean(document.querySelector('form.admin-stack #hall-cu'))`);
  await send("Runtime.evaluate", {
    expression: `(() => {
      // 受控 input：必须走原生 setter + input 事件，否则 React state 不更新
      const set = (el, value) => {
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set(document.querySelector('#hall-cu'), 'admin');
      set(document.querySelector('#hall-cp'), 'admin123');
    })()`,
  });
  await send("Runtime.evaluate", {
    expression: `document.querySelector('form.admin-stack button[type="submit"]').click()`,
  });
}
// 站长登录后「管理 🔒」变成「管理」，是登录成功的可判定信号
await waitFor(
  send,
  `[...document.querySelectorAll('.nav-pills .nav-pill')].some((n) => n.textContent.trim() === '管理')`,
);

// 大厅 / 管理：顶栏 chrome 必须与创作台同款，页面主体也要真的套上 Graphite，且各断点不溢出
for (const [label, shell, marker, probe] of [
  [
    "大厅",
    "app-shell-hall",
    ".hall-grid, .gallery-empty, .hall-head",
    // graphite.css:1395 / :1401 —— 光测不溢出抓不到这两条规则被改名或删掉
    { html: `<div class="hall-grid"><article class="hall-card"></article></div>`, sel: ".hall-card", expect: { borderTopLeftRadius: "14px" } },
  ],
  [
    "管理",
    "app-shell-settings",
    ".admin-hero",
    // graphite.css:1474
    { html: `<div class="admin-hero"></div>`, sel: ".admin-hero", expect: { borderTopLeftRadius: "20px" } },
  ],
]) {
  const switched = await send("Runtime.evaluate", {
    expression: `(() => {
      const tab = [...document.querySelectorAll('.nav-pills .nav-pill')]
        .find((node) => node.textContent.trim() === ${JSON.stringify(label)});
      if (!tab) return false;
      tab.click();
      return true;
    })()`,
    returnByValue: true,
  });
  assert.equal(switched.result.value, true, `顶栏应有「${label}」入口`);
  await waitFor(send, `Boolean(document.querySelector('.${shell}'))`);
  // 光有 shell class 不够——页面主体真的渲染出来了才算这个 tab 可用
  await waitFor(send, `Boolean(document.querySelector(${JSON.stringify(marker)}))`);

  // 注入探针量真实级联：不依赖页面当前有没有数据（空大厅没有 .hall-card）
  const probed = await send("Runtime.evaluate", {
    expression: `(() => {
      const host = document.createElement('div');
      host.innerHTML = ${JSON.stringify(probe.html)};
      document.querySelector('.page').appendChild(host);
      const node = host.querySelector(${JSON.stringify(probe.sel)});
      const style = getComputedStyle(node);
      const out = {};
      for (const key of ${JSON.stringify(Object.keys(probe.expect))}) out[key] = style[key];
      host.remove();
      return out;
    })()`,
    returnByValue: true,
  });
  for (const [key, want] of Object.entries(probe.expect)) {
    assert.equal(
      probed.result.value[key],
      want,
      `${label}页 ${probe.sel} 未套上 Graphite 样式：${key}=${probed.result.value[key]}，应为 ${want}`,
    );
  }

  for (const width of [390, 720, 1440]) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: width <= 560,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const page = await send("Runtime.evaluate", {
      expression: `(() => {
        const root = document.documentElement;
        const header = document.querySelector('.app-header');
        return {
          overflow: Math.max(root.scrollWidth, document.body.scrollWidth) - root.clientWidth,
          headerRight: Math.ceil(header.getBoundingClientRect().right),
          viewport: innerWidth,
          // chrome 是否真的继承过来：创作台给 .app-header 的圆角是 18px
          headerRadius: getComputedStyle(header).borderTopLeftRadius,
        };
      })()`,
      returnByValue: true,
    });
    const m = page.result.value;
    assert.ok(m.overflow <= 1, `${label} ${width}px 存在 ${m.overflow}px 横向溢出：${JSON.stringify(m)}`);
    assert.ok(m.headerRight <= m.viewport + 1, `${label} ${width}px 顶栏超出视口：${JSON.stringify(m)}`);
    assert.equal(m.headerRadius, "18px", `${label} ${width}px 顶栏未继承 Graphite 样式：${JSON.stringify(m)}`);
  }
}

assert.deepEqual(consoleErrors, [], `浏览器运行时出现错误：${consoleErrors.join(" | ")}`);
await send("Page.close");
socket.close();
console.log("studio browser smoke ok: 创作台 390/560/720/940/1440 + 大厅/管理 390/720/1440 无横向溢出，顶栏样式统一，模板弹窗可打开");
