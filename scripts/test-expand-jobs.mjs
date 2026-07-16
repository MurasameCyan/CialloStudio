/** 纯 JS：总张数 = 生图数量 × 并发数（× prompt 条数） */

function clampVariants(value) {
  if (!Number.isFinite(value)) return 1;
  return Math.min(8, Math.max(1, Math.round(value)));
}

function clampConcurrency(value) {
  if (!Number.isFinite(value)) return 3;
  return Math.min(8, Math.max(1, Math.round(value)));
}

function splitPrompts(raw) {
  return String(raw ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function imagesPerPrompt(variants, concurrency) {
  return clampVariants(variants) * clampConcurrency(concurrency);
}

function planJobCount(prompts, variants, concurrency) {
  const list = Array.isArray(prompts) ? prompts : splitPrompts(prompts);
  return list.length * imagesPerPrompt(variants, concurrency);
}

function expandJobs(prompts, variants, concurrency) {
  const count = imagesPerPrompt(variants, concurrency);
  const jobs = [];
  for (const prompt of prompts) {
    for (let variant = 1; variant <= count; variant += 1) {
      jobs.push({ prompt, variant, variants: count });
    }
  }
  return jobs;
}

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

// 用户公式：总张数 = 生图数量 × 并发数
{
  const prompts = splitPrompts("a cute cat");
  assert(prompts.length === 1, "single line");
  assert(planJobCount(prompts, 1, 1) === 1, "1×1=1");
  assert(expandJobs(prompts, 1, 1).length === 1, "expand 1×1");
  assert(planJobCount(prompts, 1, 3) === 3, "1×3=3");
  assert(expandJobs(prompts, 1, 3).length === 3, "expand 1×3");
  assert(planJobCount(prompts, 2, 3) === 6, "2×3=6");
  assert(expandJobs(prompts, 2, 3).length === 6, "expand 2×3");
}

// 多行再相乘：3 条 × 生图 2 × 并发 2 = 12
{
  const raw = "alpha\n\n  beta  \n\ngamma\n";
  const prompts = splitPrompts(raw);
  assert(prompts.length === 3, `expected 3 prompts, got ${prompts.length}`);
  assert(planJobCount(prompts, 2, 2) === 12, "3×2×2=12");
  assert(expandJobs(prompts, 2, 2).length === 12, "expand 3×2×2");
}

// NaN 兜底
{
  assert(clampVariants(Number("oops")) === 1, "NaN variants -> 1");
  assert(clampConcurrency(Number("oops")) === 3, "NaN concurrency -> 3");
}

// 替换语义
{
  const oldJobs = expandJobs(["old"], 2, 4); // 8
  const batch = expandJobs(["new"], 1, 1); // 1
  assert(batch.length === 1, "replace batch size");
  assert([...batch, ...oldJobs].length === 9, "append would stack");
}

console.log("planJobCount ok: total = variants × concurrency × prompts");
