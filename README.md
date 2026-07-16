# Ciallo Studio

iOS 26 风格的轻量 **AI 生图前端**。对接任意 OpenAI 兼容图片接口。

- 管理页配置 **Base URL + API Key**（浏览器 localStorage，不写 `.env`）
- 浏览器只访问同源 **`/v1`**，由 Vite / Nginx 按请求头转发到真实上游（**免 CORS**）
- 多并发生图、分享大厅
- **站长账号**由 `.env` 配置；**管理页仅站长可进**（接口 / 用户池 / 媒体 / 运行日志）
- **用户数据**：Docker 默认写入 volume `ciallo-studio-data`（`/data/community.json`），重启不丢
- **图片存储**：Cloudflare Pages/Worker → Telegram（见 [docs/telegram-media-worker.md](docs/telegram-media-worker.md)）
- Docker 仅拉 GHCR 镜像

## 快速开始（Docker）

`.env` 示例：

```env
CIALLO_PORT=8080
CIALLO_MASTER_USERNAME=admin
CIALLO_MASTER_PASSWORD=change-me
```

```bash
cp .env.example .env
# 编辑站长用户名/密码
docker compose pull
docker compose up -d
```

打开 `http://127.0.0.1:8080`：

1. **大厅** → 用站长账号登录（`.env` 中的用户名/密码）
2. **管理** → 接口设置：填 `https://你的网关/v1` + API Key → 保存 / 测试
3. **管理 → 用户池**：禁用 / 解禁 / 删除社区用户（数据在 Docker volume，换浏览器/重启仍在）

请求路径：

- 生图：浏览器 → `http://本站/v1/...` + 头 `X-Ciallo-Upstream` → 容器内 Node 代理（校验公网上游）→ 你的 API
- 社区：浏览器 → `http://本站/api/community/*` → 容器内 Node API → 文件 `/data/*.json`（volume）

上游仍可在管理页随意填写（任意公网 OpenAI 兼容地址）。服务端会拦截本机 / 内网 / 链路本地 / 云 metadata，降低 SSRF 风险。

## 本地开发

```bash
npm install
# 终端 1：社区 API（默认 http 模式需要）
# Windows PowerShell:
$env:CIALLO_DATA_DIR="$PWD/.data"; $env:CIALLO_COMMUNITY_PORT="8090"; node server/community-api.mjs
# 终端 2：
npm run dev
```

- 社区模式 **只由 env / runtime-config 决定**（默认 **http**），登录页不再切换 Mock/HTTP
- 仅无后端时：`CIALLO_COMMUNITY_MODE=mock`（Docker entrypoint 写入 runtime-config）
- 未注入站长密码时 community-api 可用 fallback 站长 **`admin` / `admin123`**，演示用户 **`demo` / `demo123`**
- 管理页填完整 `https://网关/v1`；Vite 代理读取 `X-Ciallo-Upstream`；`/api/community` → `127.0.0.1:8090`

## `.env` 变量

| 变量 | 说明 |
| --- | --- |
| `CIALLO_PORT` | 映射端口，默认 8080 |
| `CIALLO_MASTER_USERNAME` | 站长用户名（社区 admin），默认 `admin` |
| `CIALLO_MASTER_PASSWORD` | 站长密码（仅容器环境；前端只拿 sha256） |
| `CIALLO_COMMUNITY_MODE` | `http`（**默认**，volume 持久化）/ `mock`（仅浏览器 localStorage） |
| `CIALLO_MEDIA_BASE` | CF 媒体公网根 URL（Telegram 存图反代） |
| `CIALLO_MEDIA_UPLOAD_TOKEN` | 与媒体 `UPLOAD_TOKEN` 一致（可选） |
| `CIALLO_UPSTREAM_ALLOWLIST` | 内网/本机上游白名单（逗号分隔）；公网无需填写 |
| `CIALLO_DEBUG_UPSTREAM` | `1`（默认）开启 `GET /debug/upstream?url=`；`0` 关闭 |

### 用户数据 volume

`docker-compose.yml` 挂载命名卷：

```text
ciallo-studio-data → 容器 /data
  community.json      用户 / 会话 / 帖子 / 点赞 / 评论
  share-cooldown.json 分享冷却配置
```

查看：`docker volume inspect ciallo-studio-data`  
备份：导出该 volume 或复制其中的 `community.json`。

管理页**只**认站长登录（`role=admin`）可进用户池与运行日志；普通登录用户可进「设置」配接口。  
Bot Token **只**放在 Cloudflare Secrets，见媒体部署文档。

镜像固定：`ghcr.io/murasamecyan/ciallostudio:beta`

## 接口

- `GET /v1/models`（经代理）
- `POST /v1/images/generations`
- `GET /debug/upstream?url=https://你的网关/v1` — 校验上游是否会被 SSRF 防护放行（不转发）

### 本机 / 内网上游

默认拦截 `127.0.0.1`、`localhost`、`10/8` 等。要连本机 grok2api 等，在 `.env` 写：

```env
CIALLO_UPSTREAM_ALLOWLIST=http://127.0.0.1:8000,host.docker.internal
```

然后在管理页填 `http://127.0.0.1:8000/v1`（或 allowlist 中的地址）。  
调试：浏览器打开 `/debug/upstream?url=http://127.0.0.1:8000/v1` 查看 `result.ok`。

## License

MIT
