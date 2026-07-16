# 分享大厅 / 用户 / 点评 — 设计与 API 契约

> 阶段：**B 前端 + 接口契约 + Mock**  
> 后端（Docker DB + CF Worker → Telegram）后续按本契约实现。

## 目标

- 用户可注册/登录，将生图结果分享到大厅
- 大厅可浏览、点赞、星级点评
- 管理员可禁用用户、删除帖子
- 图片最终经 CF Worker 存 Telegram 私人频道；元数据存 Docker 内数据库

## 前端现状（本提交）

| 能力 | 实现 |
| --- | --- |
| 导航 | 生图 / 大厅 / 用户 / 管理 |
| 账号 | 注册、登录、退出；Mock 演示 `demo/demo123`、`admin/admin123` |
| 大厅 | 列表、搜索、详情抽屉、点赞、评论、删除 |
| 分享 | 生图结果卡「分享到大厅」 |
| API 模式 | 默认 `mock`（localStorage）；可切 `http` → `/api/community/*` |

## 架构（目标）

```
Browser (Ciallo Studio)
  ├─ 生图 → 现有 /v1 上游
  └─ 社区 → /api/community/*  (Docker API + DB)
              └─ 上传/读图 → CF Worker → Telegram 私频
```

本阶段社区请求由 `src/lib/community/client.ts` 路由到 mock 或 HTTP。

## HTTP 契约（后端实现清单）

Base：`/api/community`  
鉴权：`Authorization: Bearer <token>`（登录后）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/auth/register` | body: `{ username, password, displayName? }` → `AuthSession` |
| POST | `/auth/login` | body: `{ username, password }` → `AuthSession` |
| POST | `/auth/logout` | 注销 token |
| GET | `/auth/me` | 当前用户 |
| GET | `/posts?cursor&limit&q` | 大厅列表 |
| GET | `/posts/:id` | 详情 |
| POST | `/posts` | 发帖 body: `CreatePostInput` |
| DELETE | `/posts/:id` | 作者或管理员 |
| POST | `/posts/:id/like` | 切换点赞 → 更新后的 post |
| GET | `/posts/:id/comments` | 评论列表 |
| POST | `/posts/:id/comments` | body: `{ body, rating? }` |
| GET | `/admin/users` | 仅 admin |
| POST | `/admin/users/:id/ban` | body: `{ banned: boolean }` |

类型定义：`src/lib/community/types.ts`。

错误体建议：

```json
{ "error": { "code": "unauthorized", "message": "请先登录" } }
```

## 数据实体（Docker DB 草案）

- `users`: id, username, password_hash, display_name, role, banned, created_at
- `sessions` 或 JWT
- `posts`: id, author_id, media_id, image_url, prompt, model, aspect_ratio, resolution, caption, created_at
- `likes`: post_id, user_id
- `comments`: id, post_id, author_id, body, rating, created_at

## 图片链路（后续）

1. 前端拿到生图 URL（或 blob）
2. 上传到 CF Worker（multipart / put）
3. Worker 发到 Telegram 私人频道，返回 `mediaId` + 可访问 URL
4. `POST /posts` 只存元数据 + media 引用

## 非目标（本阶段不做）

- 真实 Docker API / Postgres
- CF Worker / Telegram 实现
- 邮箱验证、OAuth
- 服务端管理门禁替代（现有 `CIALLO_ADMIN_PASSWORD` 仍只管「管理」页配置）

## 验收（Mock）

1. 打开应用 → **用户** → `demo` / `demo123` 登录  
2. **生图** 出图后点「分享到大厅」  
3. **大厅** 可见新帖，可点赞、写点评  
4. `admin` / `admin123` 登录 → 用户管理可禁用 demo  
