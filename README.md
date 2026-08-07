# Ciallo Studio

来都来了，不点个 ⭐ 再走吗？

**为 grok 定制的 AI 生图 / 生视频前端**，经 OpenAI 兼容网关（`grok2api`）对接 xAI **Grok Imagine**。

> 传输层是 OpenAI 兼容的，但默认模型 ID、分辨率档位、视频时长、图生图与视频的请求字段形状，都是按 grok2api 的**实际行为**写死的。换成别的上游能跑通鉴权和 `/models`，但生图参数大概率对不上，需要改代码。细节见 [grok 定制说明](#grok-定制说明)。

## 功能

- **接口配置**：管理页填 API Base URL + API Key（浏览器 `localStorage`，不写进 `.env`）
- **同源代理**：浏览器只访问 `/v1`，由 Vite / 容器内 Node 转发真实上游（免 CORS）
- **自定义上游**：页面随时改网关；服务端 SSRF 防护 + 可选内网白名单
- **文生图**：多并发、结果墙、批量下载；数量 / 并发 / 分辨率 / 宽高比
- **图生图**：上传参考图 + 提示词，走 `/images/edits`；宽高比可取「源」跟随参考图
- **文生视频 / 图生视频**：`/videos/generations` 异步入队 + 轮询；参考图作首帧
- **提示词**：单行（每行一张）/ 多行（整段一张）；清除、优化与回退
- **提示词优化**：工作台一键优化（`chat/completions`），支持回退；可复用生图 API 或单独上游
- **分享大厅**：登录后点赞 / 评论 / 分享；站长管用户池与冷却
- **用户数据**：Docker volume 持久化（`/data/community.json`）
- **后台任务（VIP/站长）**：服务端任务队列，关页可续跑；普通用户仍为浏览器队列
- **图片存储（可选）**：Cloudflare Pages → Telegram（[docs/telegram-media-worker.md](docs/telegram-media-worker.md)）

## grok 定制说明

项目按 grok2api 的实际行为写死了这些地方，换上游需要改代码：

**默认模型 ID**（`src/lib/settings.ts`）

| 槽位 | 默认值 |
| --- | --- |
| 文生图 | `grok-imagine-image-lite` |
| 图生图 | `grok-imagine-image-quality` |
| 视频 | `grok-imagine-video` |
| 提示词优化 | `grok-4.5` |

这些只是**默认值**，管理页测试连接后从 `/models` 点选即可覆盖，不必改代码。

**参数档位**（`src/lib/settings.ts`）

| 项 | 取值 | 原因 |
| --- | --- | --- |
| 图片分辨率 | `1k` / `2k` | grok2api 不支持 4k：quality 会被拒，lite 直接忽略 |
| 视频分辨率 | `480p` / `720p` / `1080p` | `/videos/generations` 支持范围 |
| 视频时长 | `6` / `10` / `15` 秒 | 同上；其余值就近取整 |

**接口形状**（`src/lib/api.ts`）

- 有参考图 → `POST /images/edits`（字段 `image` / `images: { url }`）；纯文生图 → `POST /images/generations`
- 视频 → `POST /videos/generations` 返回 `request_id`，异步轮询取结果
- 模型能力表在 `src/lib/imageModels.ts`：按 ID 匹配 `imagine` / `quality` / `edit` 等关键词推断能力，未知 ID 一律按「支持 1k/2k」兜底

**媒体地址改写**（`src/lib/api.ts`）

grok2api 常返回内网地址（如 `http://127.0.0.1:8000/v1/media/...`）。前端会把它改写到当前 API base 或同源代理，否则浏览器会打到用户自己的 8000 端口。这是 grok2api 特有行为，其他上游一般不需要。

**换用其他上游**：鉴权、`/models`、`/chat/completions`（提示词优化）都是标准 OpenAI 兼容形状，可直接用；生图部分则需按上游文档调整上面几处。

## 架构（Docker）

```text
浏览器
  ├─ 静态 SPA ──────────────► Nginx :8080
  ├─ /v1/* + X-Ciallo-Upstream
  │     └─► Node v1-proxy :8091 ──(SSRF 校验)──► 公网 / 白名单上游
  ├─ /api/community/*
  │     └─► Node community-api :8090 ──► /data/*.json (volume)
  └─ /api/tasks/*（VIP/站长）
        └─► Node task-queue :8092 ──► /data/tasks.json + 代发上游生图
```

- 上游由管理页填写，经 `X-Ciallo-Upstream`（或 cookie `ciallo_upstream`）传给代理
- **不**在 `.env` 写死上游；内网需 `CIALLO_UPSTREAM_ALLOWLIST`
- 社区模式仅 env / `runtime-config.js`（默认 **http**），前端无 Mock/HTTP 切换

## 快速开始（Docker）

镜像：`ghcr.io/murasamecyan/ciallostudio:beta`

```bash
cp .env.example .env
# 编辑站长用户名/密码（必改）
docker compose up -d --pull always --remove-orphans
```

打开 `http://127.0.0.1:8080`：

1. **大厅** → 站长账号登录（`.env` 用户名/密码）
2. **管理** → 填 `https://你的网关/v1` + API Key → **测试连接** → 点选四个模型槽 → 保存
3. **管理 → 用户池**（仅站长）：禁用 / 解禁 / 删除用户

最小 `.env`：

```env
CIALLO_PORT=8080
CIALLO_MASTER_USERNAME=admin
CIALLO_MASTER_PASSWORD=change-me
```

## 本地开发

需要两个进程：社区 API + Vite。

```bash
npm install

# 终端 1 — 社区 API（PowerShell）
$env:CIALLO_DATA_DIR = "$PWD/.data"
$env:CIALLO_COMMUNITY_PORT = "8090"
$env:CIALLO_MASTER_USERNAME = "admin"
$env:CIALLO_MASTER_PASSWORD = "admin123"
npm run dev:community

# 终端 2 — 任务队列（VIP/站长后台生图，可选）
$env:CIALLO_DATA_DIR = "$PWD/.data"
$env:CIALLO_TASK_QUEUE_PORT = "8092"
$env:CIALLO_TASK_COMMUNITY_URL = "http://127.0.0.1:8090"
npm run dev:tasks

# 终端 3 — 前端
npm run dev
```

打开 `http://127.0.0.1:5173`。

| 项 | 说明 |
| --- | --- |
| 社区 | 默认 **http**；Vite 代理 `/api/community` → `127.0.0.1:8090` |
| 任务队列 | Vite 代理 `/api/tasks` → `127.0.0.1:8092`；仅 **站长/VIP** + 打开「后台任务」时走服务端 |
| 纯前端演示 | `public/runtime-config.js` 设 `communityMode: "mock"`，或 Docker `CIALLO_COMMUNITY_MODE=mock` |
| 未设站长密码 | community-api fallback **`admin` / `admin123`**；seed **`demo` / `demo123`** |
| 上游 | 管理页填完整 `https://网关/v1`；开发代理同样 SSRF 校验 |

```bash
npm run build
npm run lint
npm run test:upstream-guard
npm run pack:media-worker:pages
```

## 设置页说明

管理页分三个分页：**接口设置** / **用户池**（仅站长）/ **后台任务**（仅站长）。

「接口设置 → 接口与生成」是左右两列：

| 左 · 接口 | 右 · 模型（四个槽） |
| --- | --- |
| API Base URL / API Key | **文生图模型** |
| 测试连接 / 保存 / 恢复默认 | **图生图模型**（留空 = 不启用） |
| 连接结果提示 | **视频模型**（留空 = 不启用） |
| | **提示词优化模型** |

- **模型不可手输**，须先 **测试连接** 从 `/models` 拉列表再点选 chip；标题右侧可 **筛选** 模型 ID
- 槽位即开关：图生图 / 视频留空，工作台就不出现对应模式
- 视频槽只列 ID 带 `video` 的模型，其余槽会把视频模型排除掉
- 优化默认 **复用生图上游**；「单独设定」后可填独立 Base/Key
- 工作台：**优化提示词** → 覆盖输入框；**回退** → 恢复优化前内容
- **全局并发**在「后台任务」分页（**仅站长**），控制全站同时 running 的服务端任务上限
- **版本**：标题右侧药丸显示构建短 SHA；点刷新图标对照 GitHub 跟踪分支 HEAD（默认 `beta`，仅用户点击时请求）

## `.env` 变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CIALLO_PORT` | `8080` | 宿主机端口 |
| `CIALLO_MASTER_USERNAME` | `admin` | 站长用户名（社区 `admin`） |
| `CIALLO_MASTER_PASSWORD` | 空 | 站长密码（仅容器；前端只拿 sha256） |
| `CIALLO_COMMUNITY_MODE` | `http` | `http` 持久化 / `mock` 仅浏览器 |
| `CIALLO_COMMUNITY_API_BASE` | `/api/community` | 社区 API base |
| `CIALLO_DATA_DIR` | `/data` | 社区数据目录 |
| `CIALLO_MEDIA_BASE` | 空 | CF 媒体根 URL |
| `CIALLO_MEDIA_UPLOAD_TOKEN` | 空 | 与 Worker `UPLOAD_TOKEN` 一致（可选） |
| `CIALLO_UPSTREAM_ALLOWLIST` | 空 | 内网/本机上游白名单 |
| `CIALLO_DEBUG_UPSTREAM` | `1` | `1` 开调试接口；`0` 关 |
| `CIALLO_V1_PROXY_PORT` | `8091` | 容器内 `/v1` 代理（一般不改） |
| `CIALLO_COMMUNITY_PORT` | `8090` | 容器内社区 API（一般不改） |
| `CIALLO_BUILD_ID` | 构建时写入 | 版本 SHA（CI/`docker build --build-arg`） |
| `CIALLO_TRACK_REF` | `beta` | 版本检测跟踪分支 |
| `CIALLO_GITHUB_REPO` | `MurasameCyan/CialloStudio` | 版本检测仓库 |
| `TZ` | `Asia/Shanghai` | 时区 |

见 [`.env.example`](.env.example)。

### 用户数据 volume

```text
ciallo-studio-data → /data
  community.json
  share-cooldown.json
```

```bash
docker volume inspect ciallo-studio-data
```

## 上游与 SSRF

管理页可填任意**公网** OpenAI 兼容地址。代理会：

1. 仅允许 `http://` / `https://`
2. 拦截 loopback、RFC1918、链路本地、CGNAT、云 metadata 等
3. DNS 解析到内网 IP 也拦截

**永远禁止**（白名单无效）：`169.254.0.0/16`、`metadata.google.internal` 等。

### 本机 / 内网上游

```env
CIALLO_UPSTREAM_ALLOWLIST=http://127.0.0.1:8000,host.docker.internal,localhost
```

| 写法 | 含义 |
| --- | --- |
| `http://127.0.0.1:8000` | 精确 origin |
| `127.0.0.1` | 该 host 任意端口 |
| `host.docker.internal` | Docker 访问宿主机 |

管理页再填 `http://127.0.0.1:8000/v1`。

### 调试

```text
GET /debug/upstream?url=https://你的网关/v1
GET /api/upstream-check?url=http://127.0.0.1:8000/v1
```

看 `result.ok` / `allowlisted`。`CIALLO_DEBUG_UPSTREAM=0` 关闭。

## 权限

| 角色 | 能力 |
| --- | --- |
| 游客 | 浏览大厅 |
| 登录用户 | 点赞、评论、分享；设置页配接口与模型；工作台调并发 |
| 站长 | 用户池、分享冷却、运行日志、媒体配置、**后台任务面板 + 全局并发上限** |

站长 = `.env` 的 `CIALLO_MASTER_*`。

## 媒体存储（可选）

- 包：[`releases/ciallo-telegram-media-pages.zip`](releases/ciallo-telegram-media-pages.zip)
- 打包：`npm run pack:media-worker:pages`
- **Bot Token 只放 Cloudflare Secrets**
- Docker：`CIALLO_MEDIA_BASE`、`CIALLO_MEDIA_UPLOAD_TOKEN`

文档：[docs/telegram-media-worker.md](docs/telegram-media-worker.md) · 源码：`workers/telegram-media/`

## HTTP 接口（同源）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/healthz` | 健康检查 |
| `*` | `/v1/*` | 上游代理（`/models`、`/images/generations`、`/images/edits`、`/videos/generations`、`/chat/completions`、`/media/*`） |
| `*` | `/api/community/*` | 社区 API |
| `GET` | `/debug/upstream?url=` | 上游校验（可关） |

## 目录摘要

```text
src/                    前端
server/
  community-api.mjs     社区 API
  v1-proxy.mjs          /v1 代理
  upstream-guard.mjs    SSRF + 白名单
workers/telegram-media/ 媒体 Worker
releases/               仅 pages zip
docker/entrypoint.sh
nginx.conf
```

## 致谢
- [LINUX DO](https://linux.do/)

## License

MIT
