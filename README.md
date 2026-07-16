# Ciallo Studio

iOS 26 风格的轻量 **AI 生图前端**。对接任意 OpenAI 兼容图片接口。

- 管理页配置 **Base URL + API Key**（浏览器 localStorage，不写 `.env`）
- 浏览器只访问同源 **`/v1`**，由 Vite / Nginx 按请求头转发到真实上游（**免 CORS**）
- 多并发生图、分享大厅（Mock 契约）
- Docker 仅拉 GHCR 镜像

## 快速开始（Docker）

`.env` **只保留**：

```env
CIALLO_PORT=8080
CIALLO_ADMIN_PASSWORD=可选管理页密码
```

```bash
cp .env.example .env
docker compose pull
docker compose up -d
```

打开 `http://127.0.0.1:8080` → **管理**：

1. API Base URL：`https://你的网关/v1`（完整 URL）
2. API Key
3. 保存 → 测试连接

请求路径：浏览器 → `http://本站/v1/models` + 头 `X-Ciallo-Upstream: https://你的网关` → Nginx 反代到上游。

## 本地开发

```bash
npm install
npm run dev
```

管理页同样填完整 `https://网关/v1`；Vite 代理读取 `X-Ciallo-Upstream`。  
可选：`.env.local` 里 `VITE_DEV_PROXY_TARGET` 仅作无请求头时的回退。

## `.env` 变量

| 变量 | 说明 |
| --- | --- |
| `CIALLO_PORT` | 映射端口，默认 8080 |
| `CIALLO_ADMIN_PASSWORD` | 管理页解锁；留空关闭 |

镜像固定：`ghcr.io/murasamecyan/ciallostudio:beta`

## 接口

- `GET /v1/models`（经代理）
- `POST /v1/images/generations`

## License

MIT
