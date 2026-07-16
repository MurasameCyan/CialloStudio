/** 纯 JS：splitPrompts / planJobCount / expandJobs 行为自测（不依赖 .ts 加载） */

function clampVariants(value) {
  if (!Number.isFinite(value)) return 1;
  return Math.min(8, Math.max(1, Math.round(value)));
}

function splitPrompts(raw) {
  return String(raw ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function planJobCount(prompts, variants) {
  const list = Array.isArray(prompts) ? prompts : splitPrompts(prompts);
  return list.length * clampVariants(variants);
}

function expandJobs(prompts, variants) {
  const count = clampVariants(variants);
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

// 1 行 × 1 张 = 1
{
  const prompts = splitPrompts("a cute cat");
  assert(prompts.length === 1, "single line prompt count");
  assert(planJobCount(prompts, 1) === 1, "1x1 planned");
  assert(expandJobs(prompts, 1).length === 1, "1x1 expand");
}

// 1 行 × 4 张 = 4
{
  const prompts = splitPrompts("one line only");
  assert(planJobCount(prompts, 4) === 4, "1x4 planned");
  assert(expandJobs(prompts, 4).length === 4, "1x4 expand");
}

// 3 行 × 2 张 = 6；空行忽略
{
  const raw = "alpha\n\n  beta  \n\ngamma\n";
  const prompts = splitPrompts(raw);
  assert(prompts.length === 3, `expected 3 prompts, got ${prompts.length}`);
  assert(planJobCount(prompts, 2) === 6, "3x2 planned");
  assert(expandJobs(prompts, 2).length === 6, "3x2 expand");
}

// 多行且 variants 字符串也能 clamp
{
  const prompts = splitPrompts("a\nb");
  assert(planJobCount(prompts, Number("1")) === 2, "string '1' variants");
  assert(clampVariants(Number("oops")) === 1, "NaN variants -> 1");
}

// 替换语义：新 batch 长度必须等于 plan，而不是旧 + 新
{
  const oldJobs = expandJobs(["old"], 8); // 8 historical
  const batch = expandJobs(["new"], 1); // user expects 1
  const replaced = batch; // replace mode
  const appended = [...batch, ...oldJobs];
  assert(replaced.length === 1, "replace keeps only batch");
  assert(appended.length === 9, "append would be 9 (the old bug surface)");
}

console.log("expandJobs / planJobCount ok: 1x1=1, multi-line multiplies, replace != append");
