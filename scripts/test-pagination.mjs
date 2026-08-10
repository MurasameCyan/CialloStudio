/**
 * 客户端分页：页码钳制与切片。
 * 直接跑 TS 源，避免复制一份 JS 逻辑再漂移。
 * Run: node --experimental-strip-types scripts/test-pagination.mjs
 */
import assert from "node:assert/strict";
import { paginate } from "../src/lib/pagination.ts";

const list = Array.from({ length: 45 }, (_, i) => i);

// —— 基本切片 ——
{
  const first = paginate(list, 0, 20);
  assert.equal(first.page, 0);
  assert.equal(first.pageCount, 3, "45 条 / 每页 20 = 3 页");
  assert.deepEqual(first.items[0], 0);
  assert.equal(first.items.length, 20);

  const last = paginate(list, 2, 20);
  assert.equal(last.items.length, 5, "末页只剩 5 条");
  assert.deepEqual(last.items, [40, 41, 42, 43, 44]);
}

// —— 越界钳制：删人或换筛选后 page 可能超出总页数 ——
{
  const over = paginate(list, 99, 20);
  assert.equal(over.page, 2, "越界页码钳到末页");
  assert.equal(over.items.length, 5, "钳页后要拿到末页数据，不能是空数组");

  const negative = paginate(list, -3, 20);
  assert.equal(negative.page, 0, "负数页码钳到首页");
  assert.equal(negative.items.length, 20);

  const nan = paginate(list, Number.NaN, 20);
  assert.equal(nan.page, 0, "NaN 页码退化为首页");
  assert.equal(nan.items.length, 20);
}

// —— 空列表：pageCount 至少 1，避免 UI 显示「第 1 / 0 页」——
{
  const empty = paginate([], 0, 20);
  assert.equal(empty.pageCount, 1);
  assert.equal(empty.page, 0);
  assert.deepEqual(empty.items, []);

  const emptyOver = paginate([], 5, 20);
  assert.equal(emptyOver.page, 0, "空列表任何页码都收敛到 0");
}

// —— 边界：正好整页、pageSize 非法值 ——
{
  const exact = paginate(Array.from({ length: 40 }, (_, i) => i), 1, 20);
  assert.equal(exact.pageCount, 2, "40 条整好 2 页，不该多出空的第 3 页");
  assert.equal(exact.items.length, 20);

  const zeroSize = paginate(list, 0, 0);
  assert.equal(zeroSize.items.length, 1, "pageSize=0 兜底成 1，不能除零");
  assert.equal(zeroSize.pageCount, 45);
}

// —— 不改动入参 ——
{
  const src = [1, 2, 3];
  paginate(src, 0, 2);
  assert.deepEqual(src, [1, 2, 3], "paginate 不应改动传入数组");
}

console.log("pagination ok: 页码钳制 / 空列表 / 整页边界 / 非法入参");
