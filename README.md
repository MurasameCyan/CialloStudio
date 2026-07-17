# Ciallo Studio

来都来了，不点个 ⭐ 再走吗？

轻量 **AI 生图前端**，对接任意 OpenAI 兼容图片接口（如 grok2api）。

## 功能

- **接口配置**：管理页填 API Base URL + API Key（浏览器 `localStorage`，不写进 `.env`）
- **同源代理**：浏览器只访问 `/v1`，由 Vite / 容器内 Node 转发真实上游（免 CORS）
- **自定义上游**：页面随时改网关；服务端 SSRF 防护 + 可选内网白名单
- **生图**：多并发、结果墙、批量下载；数量 / 并发 / 分辨率 / 宽高比
- **提示词优化**：工作台一键优化（`chat/completions`），支持回退；可复用生图 API 或单独上游
- **分享大厅**：登录后点赞 / 评论 / 分享；站长管用户池与冷却
- **用户数据**：Docker volume 持久化（`/data/community.json`）
- **图片存储（可选）**：Cloudflare Pages → Telegram（[docs/telegram-media-worker.md](docs/telegram-media-worker.md)）


<img width="864" height="864" alt="Image" src="https://github.com/user-attachments/assets/dac0b592-f462-45d9-b71a-e4ca2738bed1" />
