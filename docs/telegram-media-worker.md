# Telegram 图片存储 + Cloudflare Worker 部署

把生成图经 **CF Worker** 存进 **Telegram 超级群/频道**，再通过 Worker **反代下载/访问**。

```
浏览器 / 生图页「分享到大厅」
   │  POST multipart /v1/upload
   ▼
Cloudflare Worker (本仓库 workers/telegram-media)
   │  sendDocument → Telegram Bot API
   ▼
Telegram 群/频道（file_id）
   │  GET /v1/media/:file_id
   ▼
浏览器 <img src="https://你的-worker/v1/media/...">
```

## 安全（必读）

| 放哪里 | 内容 |
| --- | --- |
| **Cloudflare Secrets** | `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`、`UPLOAD_TOKEN` |
| **浏览器 / Docker .env** | 仅 `CIALLO_MEDIA_BASE`（Worker 公网 URL）+ 可选 `CIALLO_MEDIA_UPLOAD_TOKEN` |
| **禁止** | Bot Token 写进前端、Git、截图、Issue |

你已在对话中提供过 Bot Token：**请视作已暴露**。建议在 [@BotFather](https://t.me/BotFather) **撤销/重发 Token**，新 Token 只写入 `wrangler secret`，不要再贴到聊天。

---

## 0. 前置：Telegram

1. 用 [@BotFather](https://t.me/BotFather) 创建 Bot，拿到 **Token**（`数字:字母`）。
2. 创建 **超级群或频道**（建议私有频道 + Bot 为管理员）。
3. 把 Bot 拉进群/频道，并给予 **发消息** 权限。
4. 获取 **Chat ID**（超级群多为 `-100...`）：
   - 把 Bot 拉进群后，向群发一条消息；
   - 浏览器打开：  
     `https://api.telegram.org/bot<TOKEN>/getUpdates`  
   - 在 JSON 里找 `"chat":{"id":-100...}`。

本项目约定：

- `TELEGRAM_BOT_TOKEN` = Bot Token  
- `TELEGRAM_CHAT_ID` = 群/频道 ID（例如 `-1004398134093`）

---

## 1. 部署方式（推荐 Pages 直传）

### 方式 A：Cloudflare Pages 上传 zip（推荐）

Workers 控制台对「含 JS 的 zip」会提示必须用 wrangler。请改用 **Pages → Upload assets**。

包路径：

```text
releases/ciallo-telegram-media-pages.zip
```

内容：`index.html` + **`_worker.js`**（预构建）+ `README.txt`（无 wrangler.toml）。

1. [Workers & Pages](https://dash.cloudflare.com/) → **Create** → 选 **Pages**
2. **Upload assets** / **Direct Upload**
3. 项目名例如 `ciallo-media`，上传 **`ciallo-telegram-media-pages.zip`**
4. Deploy 后：**Settings → Environment variables**（Production）添加密钥
5. 变量若后加：点 **Retry deployment** 或再传一次
6. 地址：`https://ciallo-media.pages.dev` → Studio **Media Base URL**

重新打包：`npm run pack:media-worker:pages`

### 方式 B：本机 Wrangler（Workers）

本机需 Node 18+ 与 npm。

```bash
cd workers/telegram-media
npm install
npx wrangler login
```

浏览器完成 Cloudflare 授权。

---

## 2. 写入 Secrets（不要写进仓库；Dashboard 或 wrangler 均可）

在 `workers/telegram-media` 目录执行：

```bash
# Bot Token（勿提交、勿截图）
npx wrangler secret put TELEGRAM_BOT_TOKEN
# 粘贴 Token 后回车

# 群/频道 ID
npx wrangler secret put TELEGRAM_CHAT_ID
# 例如 -1004398134093

# 强烈建议：上传口令（浏览器管理页「Upload Token」填同一个）
npx wrangler secret put UPLOAD_TOKEN
# 自己生成一段长随机串，例如 openssl rand -hex 24
```

可选 CORS 白名单（你的站点域名）：

```bash
npx wrangler secret put ALLOWED_ORIGINS
# 例：https://studio.example.com,http://127.0.0.1:5173
```

不设 `ALLOWED_ORIGINS` 时：反射请求的 `Origin`，便于本地调试。

---

## 3. 部署 Worker

```bash
cd workers/telegram-media
npm run deploy
```

成功后 Wrangler 会打印类似：

```text
https://ciallo-telegram-media.<你的子域>.workers.dev
```

记下这个 **Media Base URL**（不要带末尾 `/`）。

### 自检

```bash
curl -sS "https://你的-worker.workers.dev/healthz"
```

期望大致：

```json
{"ok":true,"telegramConfigured":true,"uploadAuth":true}
```

试传一张图（把 `UPLOAD` 换成你的 secret）：

```bash
curl -sS -X POST "https://你的-worker.workers.dev/v1/upload" \
  -H "Authorization: Bearer UPLOAD" \
  -F "file=@./test.png"
```

返回中有 `mediaId` 与 `url`，浏览器打开 `url` 应能看到图；Telegram 群里会出现一条 document。

---

## 4. 接到 Ciallo Studio 前端

### 方式 A：管理页（本地 / 任意部署）

1. 打开 **管理 → 接口设置** 下方 **「图片存储」**
2. **Media Base URL** = Worker 地址  
3. **Upload Token** = 与 `UPLOAD_TOKEN` 相同（若设了）
4. **测试 Worker** → **保存媒体配置**
5. 大厅登录后，生图结果点 **分享到大厅**：会先上传 Worker，再发帖

### 方式 B：Docker `.env`

```env
CIALLO_MEDIA_BASE=https://ciallo-telegram-media.<subdomain>.workers.dev
CIALLO_MEDIA_UPLOAD_TOKEN=与_Worker_UPLOAD_TOKEN_相同
```

`docker compose up -d` 后由 entrypoint 写入 `runtime-config.js`。

---

## 5. API 契约（Worker）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/healthz` | 健康检查 |
| POST | `/v1/upload` | `multipart/form-data` 字段 `file`（或 raw body） |
| GET | `/v1/media/:fileId` | 按 Telegram `file_id` 流式返回图片 |

### 上传成功响应示例

```json
{
  "mediaId": "BQACAgUAAxk...",
  "fileId": "BQACAgUAAxk...",
  "kind": "document",
  "url": "https://.../v1/media/BQACAgUAAxk...",
  "messageId": 12,
  "size": 345678,
  "contentType": "image/png",
  "filename": "image.png"
}
```

实现细节：

- 使用 **`sendDocument`** 保真，避免 `sendPhoto` 二次压缩  
- 读图使用 `getFile` + `https://api.telegram.org/file/bot...`  
- 长缓存：`Cache-Control: public, max-age=31536000, immutable`

### Telegram 限制（注意）

- Bot API 下载单文件约 **20MB** 上限（本 Worker 默认 `MAX_UPLOAD_BYTES=20MB`）  
- `file_id` 与 Bot 绑定：换 Bot 后旧 `file_id` 可能失效  
- 超级群 ID 以 `-100` 开头时保持原样写入 secret  

---

## 6. 自定义域名（可选）

Cloudflare Dashboard → **Workers & Pages** → `ciallo-telegram-media` → **Settings → Domains & Routes**  
绑定例如 `media.yourdomain.com`，然后把 Studio 的 Media Base 改成该域名。

---

## 7. 目录结构

```text
workers/telegram-media/
  package.json
  wrangler.toml          # 无密钥
  src/index.ts           # Worker 源码
  worker-configuration.d.ts
docs/telegram-media-worker.md   # 本文
src/lib/media/client.ts         # 前端上传客户端
```

---

## 8. 排错

| 现象 | 处理 |
| --- | --- |
| `chat not found` | Chat ID 错误，或 Bot 未进群 |
| `not enough rights` | Bot 需有发文档权限 |
| 401 上传 | `UPLOAD_TOKEN` 与前端 Upload Token 不一致 |
| CORS | 设置 `ALLOWED_ORIGINS` 为你的站点 Origin |
| 图片打不开 | 检查 `file_id` 是否来自**同一** Bot Token |
| 分享仍用临时 URL | 管理页未保存 Media Base，或 `isMediaConfigured()` 为空 |

本地调试 Worker：

```bash
cd workers/telegram-media
# 可把 secret 写到 .dev.vars（已 gitignore）再：
npx wrangler dev
```

`.dev.vars` 示例（**勿提交**）：

```env
TELEGRAM_BOT_TOKEN=你的token
TELEGRAM_CHAT_ID=-100...
UPLOAD_TOKEN=本地测试口令
```

---

## 9. 与社区大厅的关系

当前社区帖仍可 Mock 在浏览器 localStorage。  
配置 Media Worker 后：

1. 分享时上传 → 得到稳定 `url` + `mediaId`  
2. `createPost({ imageUrl, mediaId, ... })` 写入大厅  

后续 Docker DB 只需持久化 `media_id` / `image_url`，读图始终走 Worker。
