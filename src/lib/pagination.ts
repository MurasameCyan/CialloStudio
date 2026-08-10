/**
 * 客户端分页的页码钳制与切片。
 * 用户池 listUsers() 一次拉全量，筛选后在前端分页；删人或改筛选会让
 * 当前页越界，所以页码必须先钳再切，不能直接拿 page 去 slice。
 */

export type PageView<T> = {
  /** 钳到合法范围后的真实页码，0 基 */
  page: number;
  /** 总页数，空列表也算 1 页，避免 UI 显示「第 1 / 0 页」 */
  pageCount: number;
  items: T[];
};

export function paginate<T>(items: readonly T[], page: number, pageSize: number): PageView<T> {
  const size = Math.max(1, Math.floor(pageSize));
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  // 负数页码、NaN、越界都收敛到合法区间
  const requested = Number.isFinite(page) ? Math.floor(page) : 0;
  const safe = Math.min(Math.max(0, requested), pageCount - 1);
  const start = safe * size;
  return { page: safe, pageCount, items: items.slice(start, start + size) };
}
