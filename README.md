# Ciallo Studio

iOS 26 风格的轻量 **AI 生图前端**。对接任意 OpenAI 兼容图片接口（已验证 grok2api），支持：

- 管理页配置 **Base URL + API Key**（浏览器 localStorage）
- 拉取 `/v1/models` 并选择模型（默认 `grok-imagine-image`）
- 多行 prompt **多并发**生图
- 分享大厅 / 用户 / 点评（前端 + Mock 契约，后端可后续对接）
- Docker 一键部署静态镜像（GHCR multi-arch）

> API Key 与上游地址只保存在浏览器，**不进** `.env` / 镜像 / Git。

## 快速开始（Docker Compose）

Compose **只拉取** `ghcr.io/murasamecyan/ciallostudio:beta`，不本地 build。

```bash
git clone -b beta https://github.com/MurasameCyan/CialloStudio.git
cd CialloStudio
cp .env.example .env
# 只需改：CIALLO_PORT、CIALLO_ADMIN_PASSWORD
docker compose pull
docker compose up -d
```

浏览器：`http://127.0.0.1:8080`

1. **管理**（若配置了管理密码需先解锁）
2. **API Base URL** 填完整上游，例如 `https://your-gateway/v1`
3. 填 **API Key** → 保存 → 测试连接
4. 回 **生图** 出图

### `.env` 仅两项

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CIALLO_PORT` | `8080` | 宿主机端口 |
| `CIALLO_ADMIN_PASSWORD` | （空） | 管理页解锁密码；留空关闭门禁 |

上游、Key、模型、并发等 **全部在网页配置**。

### 管理密码

- entrypoint 将密码的 SHA-256 写入 `/runtime-config.js`（不写明文）
- 解锁状态在 sessionStorage
- 仅为前端门禁，公网请再加反代鉴权 / VPN

## 本地开发

```bash
npm install
# 可选：.env.local 里 VITE_DEV_PROXY_TARGET=https://your-gateway 以便使用 Base=/v1
npm run dev
```

- 地址：`http://127.0.0.1:5173`
- Base 可填绝对 URL，或 `/v1`（走 Vite 代理）

## 接口约定

- `GET {base}/models`
- `POST {base}/images/generations`

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

## 社区契约

见 `docs/superpowers/specs/2026-07-17-community-hall-design.md`。

## 镜像发布

推送 `main` / `beta` 或 `v*.*.*` tag → GitHub Actions 构建并推送 GHCR。

镜像：`ghcr.io/murasamecyan/ciallostudio:beta`

## 安全

- 不要把 API Key / 真实管理密码写进仓库
- 上游需允许浏览器 CORS（Docker 镜像不再反代上游）

## License

MIT
