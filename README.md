# Ciallo Studio

来都来了，不点个 ⭐ 再走吗？

轻量 **AI 生图前端**，对接任意 OpenAI 兼容图片接口（如 grok2api）。

## 功能

- **接口配置**：管理页填 API Base URL + API Key（浏览器 `localStorage`，不写进 `.env`）
- **同源代理**：浏览器只访问 `/v1`，由 Vite / 容器内 Node 转发真实上游（免 CORS）
- **自定义上游**：页面随时改网关；服务端 SSRF 防护 + 可选内网白名单
- **生图**：多并发、结果墙、批量下载；数量 / 并发 / 分辨率 / 宽高比
- **提示词**：单行（每行一张）/ 多行（整段一张）；清除、优化与回退
- **提示词优化**：工作台一键优化（`chat/completions`），支持回退；可复用生图 API 或单独上游
- **分享大厅**：登录后点赞 / 评论 / 分享；站长管用户池与冷却
- **用户数据**：Docker volume 持久化（`/data/community.json`）
- **图片存储（可选）**：Cloudflare Pages → Telegram（[docs/telegram-media-worker.md](docs/telegram-media-worker.md)）

## 架构（Docker）

```text
浏览器
  ├─ 静态 SPA ──────────────► Nginx :8080
  ├─ /v1/* + X-Ciallo-Upstream
  │     └─► Node v1-proxy :8091 ──(SSRF 校验)──► 公网 / 白名单上游
  └─ /api/community/*
        └─► Node community-api :8090 ──► /data/*.json (volume)
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
2. **管理** → 填 `https://你的网关/v1` + API Key → **测试连接** → 点选生图 / 优化模型 → 保存
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

# 终端 2 — 前端
npm run dev
```

打开 `http://127.0.0.1:5173`。

| 项 | 说明 |
| --- | --- |
| 社区 | 默认 **http**；Vite 代理 `/api/community` → `127.0.0.1:8090` |
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

左右两列布局：

| 左 · 生图 | 右 · 提示词优化 |
| --- | --- |
| 当前模型（点选更新） | 当前模型（点选更新） |
| API Base URL / API Key | API Base URL / API Key（复用时只读同步左侧） |
| 默认宽高比、分辨率 | 独立优化上游：复用生图 / 单独设定 |
| 全局并发槽（**仅站长**） | 优化模型列表（测试连接后点选） |
| 生图模型列表（测试连接后点选） | |

- **模型不可手输**，须先 **测试连接** 再点选 chip；标题右侧可 **筛选** 模型 ID
- 优化默认 **复用生图上游**；「单独设定」后可填独立 Base/Key
- 工作台：**优化提示词** → 覆盖输入框；**回退** → 恢复优化前内容

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
| 站长 | 用户池、分享冷却、运行日志、媒体配置、**管理页全局并发槽** |

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
| `*` | `/v1/*` | 上游代理（`/models`、`/images/generations`、`/chat/completions` 等） |
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
