# Ciallo Studio

轻量 **AI 生图前端**，对接任意 OpenAI 兼容图片接口（如 grok2api）。

## 功能

- 管理页配置 **API Base URL + API Key**
- 浏览器只访问同源 **`/v1`**，由 Vite / 容器内 Node 代理转发到真实上游
- **自定义上游**：可在页面随时改网关
- 多并发生图、结果墙、批量下载
- **分享大厅**：登录用户点赞 / 评论 / 分享；站长管用户池与分享冷却
- **用户数据**：Docker volume 持久化（`/data/community.json`）
- **图片存储（可选）**：Cloudflare Pages → Telegram （见 [docs/telegram-media-worker.md](docs/telegram-media-worker.md)）

## 架构（Docker）

```text
浏览器
  ├─ 静态 SPA ──────────► Nginx :8080
  ├─ /v1/* + X-Ciallo-Upstream
  │     └─► Node v1-proxy :8091 ──(SSRF 校验)──► 公网/白名单上游 API
  └─ /api/community/*
        └─► Node community-api :8090 ──► /data/*.json (volume)
```

- 上游地址由管理页填写，经请求头 `X-Ciallo-Upstream`（或 cookie `ciallo_upstream`）传给代理
- **不**在 `.env` 写死上游；内网地址需 `CIALLO_UPSTREAM_ALLOWLIST`
- 社区模式只由 env / `runtime-config.js` 决定（默认 **http**），前端无 Mock/HTTP 切换

## 快速开始（Docker）

镜像：`ghcr.io/murasamecyan/ciallostudio:beta`

```bash
cp .env.example .env
# 编辑站长用户名/密码（必改）
docker compose up -d --pull always --remove-orphans
```

打开 `http://127.0.0.1:8080`：

1. **大厅** → 用站长账号登录（`.env` 里的用户名/密码）
2. **管理** → 接口：填 `https://你的网关/v1` + API Key → 保存 / 测试
3. **管理 → 用户池**：禁用 / 解禁 / 删除社区用户（数据在 volume）

最小 `.env`：

```env
CIALLO_PORT=8080
CIALLO_MASTER_USERNAME=admin
CIALLO_MASTER_PASSWORD=change-me
```

## 本地开发

需要两个进程：社区 API（默认 http 模式）+ Vite。

```bash
npm install

# 终端 1 — 社区 API
# Windows PowerShell:
$env:CIALLO_DATA_DIR = "$PWD/.data"
$env:CIALLO_COMMUNITY_PORT = "8090"
$env:CIALLO_MASTER_USERNAME = "admin"
$env:CIALLO_MASTER_PASSWORD = "admin123"
npm run dev:community

# 终端 2 — 前端
npm run dev
```

打开 `http://127.0.0.1:5173`。

说明：

| 项 | 行为 |
| --- | --- |
| 社区模式 | 默认 **http**（`public/runtime-config.js`）；Vite 把 `/api/community` 代理到 `127.0.0.1:8090` |
| 纯前端演示 | 将 `public/runtime-config.js` 里 `communityMode` 改为 `"mock"`（或 Docker 设 `CIALLO_COMMUNITY_MODE=mock`） |
| 未设站长密码 | community-api 可用 fallback **`admin` / `admin123`**；seed 用户 **`demo` / `demo123`** |
| 上游 | 管理页填完整 `https://网关/v1`；开发代理同样走 SSRF 校验 |

常用脚本：

```bash
npm run build                 # tsc + vite build
npm run lint                  # tsc
npm run test:upstream-guard   # SSRF 白名单单测
npm run pack:media-worker:pages   # 打媒体 Pages zip
```

## `.env` 变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CIALLO_PORT` | `8080` | 宿主机映射端口 |
| `CIALLO_MASTER_USERNAME` | `admin` | 站长用户名（社区 `role=admin`） |
| `CIALLO_MASTER_PASSWORD` | 空 | 站长密码；**仅容器环境**；前端只拿 sha256 |
| `CIALLO_COMMUNITY_MODE` | `http` | `http` = 持久化 API；`mock` = 仅浏览器 localStorage |
| `CIALLO_COMMUNITY_API_BASE` | `/api/community` | 前端请求社区 API 的 base |
| `CIALLO_DATA_DIR` | `/data` | 社区数据目录（Docker volume） |
| `CIALLO_MEDIA_BASE` | 空 | CF 媒体公网根 URL（如 `https://ciallo-media.pages.dev`） |
| `CIALLO_MEDIA_UPLOAD_TOKEN` | 空 | 与媒体 Worker `UPLOAD_TOKEN` 一致（可选；会进 runtime-config） |
| `CIALLO_UPSTREAM_ALLOWLIST` | 空 | 内网/本机上游白名单（逗号分隔） |
| `CIALLO_DEBUG_UPSTREAM` | `1` | `1` 开启调试接口；`0` 关闭 |
| `CIALLO_V1_PROXY_PORT` | `8091` | 容器内 `/v1` 代理端口（一般无需改） |
| `CIALLO_COMMUNITY_PORT` | `8090` | 容器内社区 API 端口（一般无需改） |
| `TZ` | `Asia/Shanghai` | 时区 |

完整示例见 [`.env.example`](.env.example)。

### 用户数据 volume

```text
ciallo-studio-data → 容器 /data
  community.json       用户 / 会话 / 帖子 / 点赞 / 评论
  share-cooldown.json  分享冷却配置
```

```bash
docker volume inspect ciallo-studio-data
# 备份：导出 volume 或复制其中 community.json
```

## 上游代理与 SSRF

管理页可填**任意**公网 OpenAI 兼容 Base URL。代理层会：

1. 解析 origin（`http://` / `https://`）
2. 拦截 loopback、RFC1918、链路本地、CGNAT、云 **metadata** 等
3. 对域名做 DNS 解析，若落到内网 IP 也拦截（防 rebinding 基础防护）

**永远禁止**（白名单也无法放行）：`169.254.0.0/16`、`metadata.google.internal` 等。

### 本机 / 内网上游

连本机 grok2api 等时，在 `.env` 写白名单：

```env
CIALLO_UPSTREAM_ALLOWLIST=http://127.0.0.1:8000,host.docker.internal,localhost
```

支持写法：

| 写法 | 含义 |
| --- | --- |
| `http://127.0.0.1:8000` | 精确 origin（含端口） |
| `127.0.0.1` | 该 host 任意端口 |
| `host.docker.internal` | 主机名（Docker 访问宿主机） |

管理页再填 `http://127.0.0.1:8000/v1`（或白名单内地址）。

### 调试上游

不转发、只校验：

```text
GET /debug/upstream?url=https://你的网关/v1
GET /api/upstream-check?url=http://127.0.0.1:8000/v1
```

看 JSON 里 `result.ok` / `allowlisted`。设 `CIALLO_DEBUG_UPSTREAM=0` 可关闭。

本地 dev：`http://127.0.0.1:5173/debug/upstream?url=...`  
容器：`http://127.0.0.1:8080/debug/upstream?url=...`

## 权限

| 角色 | 能力 |
| --- | --- |
| 游客 | 浏览大厅帖子 |
| 登录用户 | 点赞、评论、分享（受冷却限制）；进「设置」配自己的上游 Key |
| 站长 (`admin`) | 用户池、分享冷却、运行日志；管理页全部能力 |

站长账号 = `.env` 的 `CIALLO_MASTER_*`，与社区 admin 为同一入口。

## 媒体存储（可选）

把生成图经 **Cloudflare Pages** 存进 **Telegram**，再按 `file_id` 反代访问。

- 部署包：[`releases/ciallo-telegram-media-pages.zip`](releases/ciallo-telegram-media-pages.zip)
- 重新打包：`npm run pack:media-worker:pages`
- **Bot Token 只放 Cloudflare Secrets**
- Docker 可注入 `CIALLO_MEDIA_BASE`、`CIALLO_MEDIA_UPLOAD_TOKEN`

完整步骤：[docs/telegram-media-worker.md](docs/telegram-media-worker.md)  
源码目录：`workers/telegram-media/`（也可用 Wrangler 从源码部署）

## HTTP 接口（同源）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/healthz` | Nginx 健康检查 |
| `GET/POST` | `/v1/*` | 上游代理（OpenAI 兼容，如 `/v1/models`、`/v1/images/generations`） |
| `*` | `/api/community/*` | 社区：注册登录、帖子、点赞评论、站长管理 |
| `GET` | `/debug/upstream?url=` | 上游 SSRF 校验（可关） |

社区 API 内部还监听 `GET /healthz`（经 `/api/community/healthz` 可达）。

## 目录结构（摘要）

```text
src/                 前端 React
server/
  community-api.mjs  社区持久化 API
  v1-proxy.mjs       /v1 动态上游代理
  upstream-guard.mjs SSRF + 白名单
workers/telegram-media/   媒体 Worker 源码
releases/            仅 pages 媒体 zip
docker/entrypoint.sh 生成 runtime-config + 启动进程
nginx.conf           反代 /v1、/api/community、/debug/upstream
```


## License

MIT
