/**
 * 固定 worker 数的并发池。
 * 保证同一时刻最多 concurrency 个 worker 在执行。
 */
export async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  options?: {
    onItemSettled?: (index: number, result: PromiseSettledResult<R>) => void;
    onInFlightChange?: (inFlight: number) => void;
    onLog?: (message: string, detail?: unknown) => void;
  },
): Promise<PromiseSettledResult<R>[]> {
  const total = items.length;
  const results: PromiseSettledResult<R>[] = new Array(total);

  if (total === 0) return results;

  const limit = Math.max(1, Math.min(Math.floor(Number(concurrency)) || 1, total));
  const queue: number[] = Array.from({ length: total }, (_, i) => i);

  let inFlight = 0;
  const setInFlight = (n: number) => {
    inFlight = n;
    options?.onInFlightChange?.(n);
  };

  options?.onLog?.(`启动并发池：workers=${limit} · tasks=${total}`);

  const runWorker = async (workerId: number): Promise<void> => {
    for (;;) {
      const index = queue.shift();
      if (index === undefined) return;

      setInFlight(inFlight + 1);
      options?.onLog?.(`并发槽 #${workerId + 1} 领取任务 ${index + 1}/${total}`, {
        inFlight,
        concurrency: limit,
      });

      try {
        const value = await worker(items[index], index);
        const settled: PromiseFulfilledResult<R> = { status: "fulfilled", value };
        results[index] = settled;
        options?.onItemSettled?.(index, settled);
      } catch (error) {
        const settled: PromiseRejectedResult = { status: "rejected", reason: error };
        results[index] = settled;
        options?.onItemSettled?.(index, settled);
      } finally {
        setInFlight(Math.max(0, inFlight - 1));
      }
    }
  };

  await Promise.all(Array.from({ length: limit }, (_, id) => runWorker(id)));
  return results;
}
