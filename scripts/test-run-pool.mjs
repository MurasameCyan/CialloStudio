/** 纯 JS 并发池自测（不依赖 TS 加载） */
async function runPoolJs(items, concurrency, worker, onInFlight) {
  const total = items.length;
  const results = new Array(total);
  if (total === 0) return results;
  const limit = Math.max(1, Math.min(Math.floor(Number(concurrency)) || 1, total));
  const queue = Array.from({ length: total }, (_, i) => i);
  let inFlight = 0;
  const setInFlight = (n) => {
    inFlight = n;
    onInFlight?.(n);
  };
  const runWorker = async () => {
    for (;;) {
      const index = queue.shift();
      if (index === undefined) return;
      setInFlight(inFlight + 1);
      try {
        const value = await worker(items[index], index);
        results[index] = { status: "fulfilled", value };
      } catch (error) {
        results[index] = { status: "rejected", reason: error };
      } finally {
        setInFlight(Math.max(0, inFlight - 1));
      }
    }
  };
  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return results;
}

let max = 0;
const starts = [];
await runPoolJs(
  [0, 1, 2, 3, 4],
  2,
  async (x) => {
    starts.push(Date.now());
    await new Promise((r) => setTimeout(r, 60));
    return x;
  },
  (n) => {
    max = Math.max(max, n);
  },
);

if (max !== 2) {
  console.error("expected max inFlight 2, got", max);
  process.exit(2);
}
if (starts.length !== 5) {
  console.error("expected 5 starts, got", starts.length);
  process.exit(3);
}
if (starts[1] - starts[0] > 30) {
  console.error("first two workers did not start concurrently", starts[1] - starts[0]);
  process.exit(4);
}
console.log("runPool concurrency ok: maxInFlight=2 tasks=5");
