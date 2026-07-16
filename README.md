# Ciallo Studio

iOS 26 风格的轻量 **AI 生图前端**。对接任意 OpenAI 兼容图片接口。

- 管理页配置 **Base URL + API Key**（浏览器 localStorage，不写 `.env`）
- 浏览器只访问同源 **`/v1`**，由 Vite / Nginx 按请求头转发到真实上游（**免 CORS**）
- 多并发生图、分享大厅（Mock 契约）
- **站长账号**由 `.env` 配置，管理权限与站长登录合一（无单独管理密码）
- **图片存储**：Cloudflare Worker → Telegram（见 [docs/telegram-media-worker.md](docs/telegram-media-worker.md)）
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
3. **管理 → 用户池**：禁用 / 解禁 / 删除社区用户

请求路径：浏览器 → `http://本站/v1/models` + 头 `X-Ciallo-Upstream: https://你的网关` → Nginx 反代到上游。

## 本地开发

```bash
npm install
npm run dev
```

- 未注入 `.env` 站长时：Mock 站长 **`admin` / `admin123`**，演示用户 **`demo` / `demo123`**
- 管理页同样填完整 `https://网关/v1`；Vite 代理读取 `X-Ciallo-Upstream`
- 可选：`.env.local` 里 `VITE_DEV_PROXY_TARGET` 仅作无请求头时的回退

## `.env` 变量

| 变量 | 说明 |
| --- | --- |
| `CIALLO_PORT` | 映射端口，默认 8080 |
| `CIALLO_MASTER_USERNAME` | 站长用户名（社区 admin），默认 `admin` |
| `CIALLO_MASTER_PASSWORD` | 站长密码（仅容器环境；前端只拿 sha256） |
| `CIALLO_ADMIN_PASSWORD` | **兼容旧名**：未设 `CIALLO_MASTER_PASSWORD` 时当作站长密码 |
| `CIALLO_MEDIA_BASE` | CF Worker 公网根 URL（Telegram 存图反代） |
| `CIALLO_MEDIA_UPLOAD_TOKEN` | 与 Worker `UPLOAD_TOKEN` 一致（可选） |

不再使用单独的「管理页解锁密码」：登录站长即拥有接口设置 + 用户池权限。  
Bot Token **只**放在 Cloudflare Secrets，见媒体部署文档。

镜像固定：`ghcr.io/murasamecyan/ciallostudio:beta`

## 接口

- `GET /v1/models`（经代理）
- `POST /v1/images/generations`

## License

MIT
