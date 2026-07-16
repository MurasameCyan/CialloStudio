# Ciallo Studio

iOS 26 风格的轻量 **AI 生图前端**。对接任意 OpenAI 兼容图片接口（已验证 grok2api），支持：

- 管理页配置 **Base URL + API Key**
- 拉取 `/v1/models` 并选择模型（默认 `grok-imagine-image`）
- 多行 prompt **多并发**生图
- Docker 一键部署，GitHub Actions 自动构建 **linux/amd64 + linux/arm64** 镜像

> API Key 只保存在浏览器 `localStorage`，不会进入镜像或 Git 仓库。

## 快速开始（Docker Compose）

```bash
git clone -b beta https://github.com/MurasameCyan/CialloStudio.git
cd CialloStudio
cp .env.example .env   # 按需修改上游地址
docker compose up -d --build
```

浏览器打开：`http://127.0.0.1:8080`

1. 进入 **管理**
2. Base URL 保持 `/v1`（容器内 Nginx 同源反代到上游）
3. 填入你的 `g2a_...` API Key
4. 点 **测试连接**
5. 回到 **生图** 开始出图

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CIALLO_PORT` | `8080` | 宿主机端口 |
| `CIALLO_UPSTREAM` | `https://your-grok2api.example.com` | 上游网关根地址（可带或不带 `/v1`） |
| `CIALLO_IMAGE` | `ghcr.io/murasamecyan/ciallostudio:beta` | 镜像名（本地 build 也会打此 tag） |
| `TZ` | `Asia/Shanghai` | 时区 |

示例：

```bash
# Linux / macOS
CIALLO_UPSTREAM=https://your-grok2api.example.com CIALLO_PORT=8080 docker compose up -d --build

# Windows PowerShell
$env:CIALLO_UPSTREAM="https://your-grok2api.example.com"
$env:CIALLO_PORT="8080"
docker compose up -d --build
```

代理宿主机上的 grok2api：

```yaml
# docker-compose.yml 中取消 extra_hosts 注释，并设置：
# CIALLO_UPSTREAM=http://host.docker.internal:8000
```

## 本地开发

```bash
npm install
npm run dev
```

开发服务器默认 `http://127.0.0.1:5173`，并把 `/v1` 代理到示例上游（见 `vite.config.ts`，请改成你自己的网关）。

可覆盖：

```bash
# Windows PowerShell
$env:VITE_DEV_PROXY_TARGET="https://your-host"
npm run dev
```

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
