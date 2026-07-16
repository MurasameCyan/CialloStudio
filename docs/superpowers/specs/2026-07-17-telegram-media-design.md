# Telegram + CF Worker 媒体存储设计

> 状态：Worker 已落地脚手架；密钥仅 Cloudflare Secrets。

## 目标

- 用 Telegram 作廉价对象存储（群/频道 document）
- 用 Cloudflare Worker 统一 **上传 / 下载 / CORS / 鉴权**
- 浏览器永不持有 Bot Token

## 数据流

1. 用户生图得到 blob / 上游 URL  
2. 前端 `uploadMedia()` → `POST {mediaBase}/v1/upload`  
3. Worker `sendDocument` 到 `TELEGRAM_CHAT_ID`  
4. 返回 `file_id` 与 `GET /v1/media/{file_id}`  
5. 大厅帖子存 `imageUrl` + `mediaId`

## 密钥边界

| 密钥 | 位置 |
| --- | --- |
| Bot Token | Worker Secret `TELEGRAM_BOT_TOKEN` |
| Chat ID | Worker Secret `TELEGRAM_CHAT_ID` |
| 上传口令 | Worker Secret `UPLOAD_TOKEN`；前端可选 `mediaUploadToken` |
| Media Base | 公开：Docker `CIALLO_MEDIA_BASE` / 管理页 / runtime |

## 非目标

- 不在 Worker 内实现社区用户体系  
- 不替代生图上游 `/v1`  
- 不做图片审核 / CDN 变换（可后续加）

## 部署

见 [telegram-media-worker.md](../telegram-media-worker.md)。
