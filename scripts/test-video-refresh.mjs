/**
 * 视频完成后的刷新恢复：展示 URL 可以是 blob，但 openUrl 必须是可持久化地址。
 * Run: node scripts/test-video-refresh.mjs
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const entry = fileURLToPath(new URL("../src/lib/api.ts", import.meta.url));
const outfile = new URL("./.tmp-video-refresh-test.mjs", import.meta.url);
await build({
  entryPoints: [entry],
  outfile: fileURLToPath(outfile),
  bundle: true,
  platform: "browser",
  format: "esm",
  logLevel: "silent",
});

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalCreateObjectURL = URL.createObjectURL;
try {
  const { generateVideo } = await import(`${outfile.href}?t=${Date.now()}`);
  globalThis.window = { location: { origin: "http://localhost:5173" } };
  const responses = [
    { request_id: "video_test" },
    {
      status: "done",
      progress: 100,
      video: {
        url: "https://upstream.example/v1/videos/video_test/content",
        duration: 6,
      },
    },
  ];

  globalThis.fetch = async (_url, init) => {
    if (init?.method === "GET" && String(_url).includes("/v1/videos/video_test/content")) {
      return new Response(new Blob(["video"], { type: "video/mp4" }), { status: 200 });
    }
    const payload = responses.shift();
    assert.ok(payload, `出现未预期请求：${String(_url)}`);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  URL.createObjectURL = () => "blob:http://localhost/video-preview";

  const result = await generateVideo({
    baseUrl: "https://upstream.example/v1",
    apiKey: "test-key",
    model: "grok-imagine-video",
    prompt: "test",
    duration: 6,
    aspectRatio: "16:9",
    resolution: "720p",
  });

  assert.equal(result.url, "blob:http://localhost/video-preview", "当前会话使用 blob 预览");
  assert.equal(
    result.openUrl,
    "/v1/videos/video_test/content",
    "openUrl 必须保留可持久化媒体路径，刷新后才能重新 blob 化",
  );

  console.log("PASS: video refresh keeps a persistable openUrl");
} finally {
  globalThis.fetch = originalFetch;
  URL.createObjectURL = originalCreateObjectURL;
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
  await import("node:fs/promises").then(({ unlink }) => unlink(outfile).catch(() => undefined));
}
