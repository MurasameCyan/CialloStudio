# Ciallo Studio

iOS 26 风格的轻量 **AI 生图前端**。对接任意 OpenAI 兼容图片接口（已验证 grok2api），支持：

- 管理页配置 **Base URL + API Key**
- 拉取 `/v1/models` 并选择模型（默认 `grok-imagine-image`）
- 多行 prompt **多并发**生图
- Docker 一键部署，GitHub Actions 自动构建 **linux/amd64 + linux/arm64** 镜像

> API Key 只保存在浏览器 `localStorage`，不会进入镜像或 Git 仓库。

## 快速开始（Docker Compose）

> Compose **只拉取镜像**，不再本地 `build`。镜像由 GitHub Actions 推送到 GHCR。

```bash
git clone -b beta https://github.com/MurasameCyan/CialloStudio.git
cd CialloStudio
cp .env.example .env
# 编辑 .env：CIALLO_UPSTREAM、CIALLO_ADMIN_PASSWORD 等
docker compose pull
docker compose up -d
```

浏览器打开：`http://127.0.0.1:8080`

1. 进入 **管理**（若配置了 `CIALLO_ADMIN_PASSWORD` 需先输入密码）
2. Base URL 保持 `/v1`（容器内 Nginx 同源反代到上游）
3. 填入你的 `g2a_...` API Key
4. 点 **测试连接**
5. 回到 **生图** 开始出图

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CIALLO_PORT` | `8080` | 宿主机端口 |
| `CIALLO_UPSTREAM` | `https://your-grok2api.example.com` | 上游网关根地址（可带或不带 `/v1`） |
| `CIALLO_ADMIN_PASSWORD` | （空） | 管理页解锁密码；**留空关闭门禁**。只写在 `.env`，不要提交 |
| `CIALLO_IMAGE` | `ghcr.io/murasamecyan/ciallostudio:beta` | 使用的镜像 |
| `CIALLO_PULL_POLICY` | `always` | compose 拉取策略：`always` / `missing` / `never` |
| `TZ` | `Asia/Shanghai` | 时区 |

示例：

```bash
# Linux / macOS
export CIALLO_UPSTREAM=https://your-grok2api.example.com
export CIALLO_ADMIN_PASSWORD='your-strong-password'
export CIALLO_PORT=8080
docker compose pull && docker compose up -d

# Windows PowerShell
$env:CIALLO_UPSTREAM="https://your-grok2api.example.com"
$env:CIALLO_ADMIN_PASSWORD="your-strong-password"
$env:CIALLO_PORT="8080"
docker compose pull
docker compose up -d
```

代理宿主机上的 grok2api：

```yaml
# docker-compose.yml 中取消 extra_hosts 注释，并设置：
# CIALLO_UPSTREAM=http://host.docker.internal:8000
```

### 管理密码说明

- 密码来自 `.env` 的 `CIALLO_ADMIN_PASSWORD`，由容器 entrypoint 算 **SHA-256** 写入 `/runtime-config.js`（**不写明文**）。
- 浏览器只比对哈希；解锁状态存在 **sessionStorage**（关标签后需重新输入）。
- 这是前端门禁，用于挡住随便点进管理页改配置；**不是**完整的服务端鉴权。公网请再加反向代理鉴权 / VPN。
- 需要本地改代码并构建镜像时，请用 `docker build` / CI，而不是 `docker compose up --build`。

## 本地开发

```bash
npm install
# 先配置上游，否则「测试连接」会失败（默认是占位域名）
cp .env.example .env.local
# 编辑 .env.local：把 VITE_DEV_PROXY_TARGET 改成你的 grok2api 根地址
npm run dev
```

开发服务器：`http://127.0.0.1:5173`  
管理页 Base URL 保持 **`/v1`**（由 Vite 同源代理到 `VITE_DEV_PROXY_TARGET`）。

也可用环境变量一次性覆盖：

```bash
# Windows PowerShell
$env:VITE_DEV_PROXY_TARGET="https://你的网关"
npm run dev
```

若出现「连不上 / 网络失败 / HTTP 500|502」：

1. 看终端是否打印 `[ciallo] 开发代理仍指向占位上游`
2. 确认 `VITE_DEV_PROXY_TARGET` 是真实可访问的 grok2api（不是 `your-grok2api.example.com`）
3. **改完代理必须重启** `npm run dev`（Vite 只在启动时读代理配置）
4. 管理页 Base URL = `/v1`，填对 API Key 后再点「测试连接」

## 接口约定

- `GET /v1/models`
- `POST /v1/images/generations`

请求体示例：

```json
{
  "model": "grok-imagine-image",
  "prompt": "a cute cat",
  "n": 1,
  "aspect_ratio": "1:1",
  "resolution": "1k",
  "response_format": "url",
  "stream": false
}
```

若上游返回内网媒体地址（如 `http://127.0.0.1:8000/v1/media/...`），前端会按当前 Base URL 自动改写主机。

## 镜像发布

推送到 `main` / `beta` 或打 `v*.*.*` tag 后，GitHub Actions 会：

1. `npm ci && npm run build`
2. 分别在 amd64 / arm64 runner 构建并推送
3. 合并 multi-arch manifest 到 GHCR

镜像：`ghcr.io/murasamecyan/ciallostudio`

## 安全提示

- 不要把 API Key 写进代码、README、compose 或镜像
- 公网部署时请自行加访问控制（反代鉴权 / VPN / 防火墙）
- 本项目仅提供前端调用能力，请遵守上游服务条款与当地法律

## License

MIT
