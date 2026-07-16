# 大厅数据持久化展示落地 — 设计规格

日期：2026-07-17  
状态：已批准  
范围：Docker 社区持久化交付 + 大厅前端展示增强（加载更多 / 图链兜底 / 图裂占位）

## 背景

- 社区存储已对接：`server/community-api.mjs` → `/data/community.json`（Docker volume）；前端 `communityMode=http` + `/api/community/*`。
- 相关对接多在工作区未完全提交；大厅 `HallPage` 已能 `listPosts` 展示，但：
  - 固定 `limit: 40`，未用 `nextCursor` 做加载更多；
  - 仅用 `post.imageUrl`，未在裂图时回退 `mediaId`；
  - 图裂时无占位。

用户确认：在持久化验收基础上增强展示，范围 **1+2+3**（加载更多、mediaId 图链兜底、图裂占位）。不包含分享成功后自动刷新大厅。

## 目标

1. **交付** Docker 持久化链路：分享写入 volume 后，刷新/换会话仍能在大厅看到。
2. **加载更多**：使用 API 已有 `cursor` / `nextCursor`。
3. **图链兜底**：`imageUrl` 优先；失败时用 `mediaBase + /v1/media/{mediaId}`。
4. **图裂占位**：双 URL 都失败时显示灰底占位，不白裂、不无限 onError。

## 非目标

- 无限滚动 / 虚拟列表 / 瀑布流重设计。
- 分享成功后自动跳转或强制刷新大厅列表。
- 改 community 数据模型、角色权限、生图上游。
- 把本地 dev 默认从 mock 改为 http（本地仍 mock；Docker 默认 http）。

## 架构

```
Browser HallPage
  listPosts({ limit, cursor, q }) ──► /api/community (Docker) ──► /data/community.json
  createPost (Studio) ─────────────► 同上

展示 URL:
  resolvePostImageUrl(post)
    1. post.imageUrl（非空）
    2. else mediaId + getMediaBase() → `${base}/v1/media/${mediaId}`
    3. else ""

  img onError:
    若尚未尝试 fallback 且 fallback ≠ 当前 src → 换 fallback 一次
    否则 → 占位 UI
```

## 持久化交付（提交已有对接）

确保并提交（若尚未入 git）：

| 路径 | 职责 |
|------|------|
| `server/community-api.mjs` | Node 社区 API，写 `/data` |
| `docker/entrypoint.sh` | 启动 API、注入 `communityMode` / `communityApiBase` |
| `nginx.conf` | `/api/community/` → `127.0.0.1:8090` |
| `docker-compose.yml` / `Dockerfile` / `.env.example` | volume、env、拷贝 server |
| `src/lib/runtimeConfig.ts` / `public/runtime-config.js` | 运行时 community 配置 |
| `src/lib/community/client.ts` | mode 读 runtime，支持 http |
| `docs` / `README` 相关说明 | 与实现一致 |

行为约定：

- Docker 默认 `CIALLO_COMMUNITY_MODE=http`，数据 `CIALLO_DATA_DIR`（默认 `/data`）+ compose volume。
- 本地 dev：`communityMode: "mock"`，数据在浏览器 localStorage。
- 列表/点赞/评论契约不变；后端已支持 `cursor`、`limit`、`nextCursor`、`mediaId`。

## 展示增强

### 1. 加载更多

**文件：** `src/components/HallPage.tsx`

- 首屏：`listPosts({ limit: 24, q })`（或 20–24，与后端默认 20 兼容）。
- 状态：`posts`、`nextCursor`、`listLoading`（首屏）、`loadingMore`、`error`。
- 「加载更多」：仅当 `nextCursor` 存在；调用 `listPosts({ limit, cursor: nextCursor, q })`，**追加** `items`，更新 `nextCursor`。
- 搜索（改 `q` 并点搜索 / Enter）：重置 `posts` 与 `nextCursor`，重新首屏加载。
- 首屏与加载更多互不覆盖：加载更多失败时保留已有列表并展示 error。

### 2. 图链解析

**新建：** `src/lib/community/postImage.ts`（或等价小模块）

```ts
export function resolvePostImageUrl(post: { imageUrl?: string; mediaId?: string }): string
export function fallbackPostImageUrl(
  post: { imageUrl?: string; mediaId?: string },
  failedUrl: string,
): string | null
```

- `resolvePostImageUrl`：优先 trim 后的 `imageUrl`；否则有 `mediaId` 且 `getMediaBase()` 非空时返回媒体 URL。
- `fallbackPostImageUrl`：在 `failedUrl` 失败后，若存在与 `failedUrl` 不同的 media URL 则返回，否则 `null`。
- 依赖现有 `getMediaBase()`（`src/lib/media/client.ts`），不新增后端字段。

### 3. 图裂占位

**文件：** `HallPage.tsx`（网格卡 + 详情抽屉）

- `<img src={resolved} onError={...} />`。
- 组件内用 map/set 或 per-post state 记录「已尝试 fallback」；最多切换一次。
- 最终失败：替换为占位块（灰底 + 文案如「图不可用」），不继续触发 onError 循环。
- 样式：复用现有 hall 卡片比例；必要时在 `src/styles` 增加 `.hall-media-placeholder` 一类规则。

## 错误与边界

| 场景 | 行为 |
|------|------|
| HTTP 社区 API 不可达 | 展示 error，不假装有数据 |
| 空列表 | 保持现有「暂无分享」空态 |
| 仅 imageUrl 有效 | 正常显示 |
| imageUrl 坏、mediaId 有效且配置了 mediaBase | onError 后切 media URL |
| 均无/均坏 | 占位 |
| 未配置 mediaBase 且仅 mediaId | 无法拼 URL → 占位 |
| mock 模式 | 同样走 resolve/fallback；seed 图为 data URL 应直接显示 |

## 测试要点

1. Docker：分享帖 → 硬刷新 → 仍在列表。
2. 造 >24 条（或临时 limit=2）→ 「加载更多」追加且无重复错乱。
3. 人为坏 `imageUrl`、保留 `mediaId` + mediaBase → 显示媒体图。
4. 双坏 → 占位。
5. `npm run build` 通过。

## 成功标准

1. 持久化链路已提交且文档与运行方式一致。  
2. 大厅支持加载更多。  
3. 图链兜底与图裂占位按上表工作。  
4. 不引入分享后自动刷新等非目标能力。  
