# Ciallo Telegram Media Worker — 部署包

本包**不含任何密钥**。所有配置只在 Cloudflare 控制台或 `wrangler secret` 中设置。

## 架构

```
POST /v1/upload  → Telegram sendDocument → 返回 mediaId + url
GET  /v1/media/:fileId → 反代 Telegram 文件
GET  /healthz
```

## Cloudflare 变量一览（全部在 CF 侧设定）

| 名称 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | **Secret** | 是 | BotFather 的 Bot Token |
| `TELEGRAM_CHAT_ID` | **Secret** | 是 | 群/频道 ID，如 `-1004398134093` |
| `UPLOAD_TOKEN` | **Secret** | 强烈建议 | 上传鉴权；浏览器管理页填同一个 |
| `ALLOWED_ORIGINS` | Secret 或 Variable | 否 | CORS 白名单，逗号分隔；空=反射 Origin |
| `MAX_UPLOAD_BYTES` | Variable | 否 | 默认 `20971520`（20MB） |

> Bot Token **不要**写进本 zip、Git、前端。

---

## 方式 0：Dashboard 上传预构建 zip（网页无法接受 wrangler 项目时）

使用仓库产物：

```text
releases/ciallo-telegram-media-dashboard.zip
```

- 内含：`worker.js` + `README.txt`（**无 wrangler.toml**）
- Cloudflare 网页上传不会再提示「请用 wrangler deploy」
- 上传后在 **Settings → Variables and Secrets** 配置下表变量并 Deploy

本地重新生成：

```bash
# 在仓库根目录
npm run pack:media-worker:dashboard
```

---

## 方式 A：Wrangler（推荐）

### 1. 解压

```bash
unzip ciallo-telegram-media-worker.zip -d ciallo-telegram-media
cd ciallo-telegram-media
npm install
npx wrangler login
```

### 2. 写入 Secrets（交互粘贴）

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put UPLOAD_TOKEN
# 可选
npx wrangler secret put ALLOWED_ORIGINS
```

### 3. 部署

```bash
npx wrangler deploy
```

记下输出的 `https://ciallo-telegram-media.<subdomain>.workers.dev`。

### 4. 自检

```bash
curl -sS "https://你的地址/healthz"
```

期望：`"telegramConfigured":true`。

---

## 方式 B：Cloudflare Dashboard 创建 Worker 后绑 Secrets

1. [Workers & Pages](https://dash.cloudflare.com/) → **Create** → **Worker**  
2. 用本机 Wrangler 从本目录 `deploy` 覆盖代码（Dashboard 纯 UI 对 TS 项目不友好，仍建议 A）  
3. Worker → **Settings → Variables and Secrets**：  
   - 添加上表全部 Secret / Variable  
4. **Deploy**

---

## 接到 Ciallo Studio

**管理 → 图片存储**

| 字段 | 填什么 |
| --- | --- |
| Media Base URL | `https://ciallo-telegram-media.xxx.workers.dev`（无尾斜杠） |
| Upload Token | 与 `UPLOAD_TOKEN` 相同 |

或 Docker `.env`：

```env
CIALLO_MEDIA_BASE=https://ciallo-telegram-media.xxx.workers.dev
CIALLO_MEDIA_UPLOAD_TOKEN=你的UPLOAD_TOKEN
```

---

## Telegram 侧检查清单

1. Bot 已拉进目标群/频道  
2. Bot 有发消息/文档权限  
3. Chat ID 正确（超级群多为 `-100...`）  
4. Token 已在 BotFather 管理（若曾泄露请 Revoke 换新）

---

## 试传

```bash
curl -sS -X POST "https://你的地址/v1/upload" \
  -H "Authorization: Bearer 你的UPLOAD_TOKEN" \
  -F "file=@./test.png"
```

返回的 `url` 在浏览器打开应能显示图片；群内应有一条 document。
