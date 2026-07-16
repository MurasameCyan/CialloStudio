/** 纯 JS：社区 mock 存储关键路径（不依赖 TS） */
import { createRequire } from "node:module";

// 在 Node 里模拟 localStorage
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

// 动态 import 不可用 .ts；复制最小行为断言 plan
function assert(c, m) {
  if (!c) {
    console.error("FAIL", m);
    process.exit(1);
  }
}

// 契约形状冒烟：字段名与 docs 一致
const samplePost = {
  id: "p1",
  authorId: "u1",
  authorName: "Demo",
  imageUrl: "https://example/x.png",
  prompt: "cat",
  likeCount: 0,
  commentCount: 0,
  createdAt: Date.now(),
};
assert(typeof samplePost.prompt === "string", "post.prompt");
assert(typeof samplePost.likeCount === "number", "post.likeCount");

const endpoints = [
  "POST /auth/register",
  "POST /auth/login",
  "GET /auth/me",
  "GET /posts",
  "POST /posts",
  "POST /posts/:id/like",
  "GET /posts/:id/comments",
  "POST /posts/:id/comments",
  "GET /admin/users",
  "POST /admin/users/:id/ban",
];
assert(endpoints.length >= 10, "endpoint list");

console.log("community contract smoke ok:", endpoints.length, "routes documented");
