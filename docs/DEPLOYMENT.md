# Defuddle Cloudflare Worker 部署指南

## 概述

这是一个简化版的 Defuddle 服务，部署在 Cloudflare Workers 上，可以将任意网页转换为干净的 Markdown 格式。

**在线演示：**
- Worker: https://defuddle-free.877781132.workers.dev
- GitHub Pages: https://hhhaiai.github.io/defuddle/ (自动跳转到 Worker)

## 功能

- 将网页 URL 转换为 Markdown 格式
- 将网页 URL 转换为 HTML 格式（使用 `/html/` 前缀）
- 支持 YouTube、GitHub、Reddit 等网站专用提取器
- 无需 API Key，完全免费使用
- 服务端获取，无 CORS 跨域问题

## 快速使用

### 直接访问

```
https://defuddle-free.877781132.workers.dev/https://目标URL
```

### 示例

```bash
# 转换网页为 Markdown
curl https://defuddle-free.877781132.workers.dev/https://stephango.com/saw

# 转换 Twitter 帖子
curl https://defuddle-free.877781132.workers.dev/https://x.com/op7418/status/2044634498432962806

# 获取 HTML 格式
curl https://defuddle-free.877781132.workers.dev/html/https://example.com/article
```

## 部署到自己的 Cloudflare 账户

### 前置要求

- Cloudflare 账户（免费即可）
- Node.js 18+

### 部署步骤

```bash
# 1. 克隆仓库
git clone https://github.com/hhhaiai/defuddle.git
cd defuddle/website-free

# 2. 安装依赖
npm install

# 3. 登录 Cloudflare
npx wrangler login

# 4. 部署
npx wrangler deploy
```

部署成功后，会输出 Workers URL，例如：
```
https://defuddle-free-xxxx.workers.dev
```

### 部署到 GitHub Pages

GitHub Pages 部署在 `docs/` 目录，会自动跳转到 Cloudflare Worker：

1. 进入 GitHub 仓库 Settings → Pages
2. Source 选择 `docs/` 目录
3. 访问 `https://你的用户名.github.io/defuddle/` 会自动跳转到 Worker

### 自定义域名

如果你有自己的域名（如 `defuddle.yourdomain.com`）：

1. 进入 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 选择你的 Worker → Settings → Triggers
3. 点击 Add Custom Domain
4. 输入你的域名

**注意**：如果使用 GitHub Pages 自定义域名（如 `simitalk.de5.net`），Worker 的自定义域名需要单独配置，不能共用同一个域名。

## 工作原理

```
┌─────────────┐     ┌──────────────────┐     ┌────────────────┐
│   用户      │────▶│  Cloudflare      │────▶│   目标网页     │
│  浏览器     │◀────│  Worker          │◀────│  (fetch 获取)  │
└─────────────┘     └──────────────────┘     └────────────────┘
       │                    │
       │                    ▼
       │            ┌──────────────────┐
       │            │  Defuddle 解析  │
       │            │  + Turndown     │
       │            │  → Markdown     │
       │            └──────────────────┘
       │                    │
       ▼                    ▼
┌─────────────────────────────────────┐
│           返回 Markdown             │
│  + YAML frontmatter (元数据)        │
└─────────────────────────────────────┘
```

## 返回格式

```markdown
---
title: "Article Title"
author: "Author Name"
site: "Site Name"
published: 2024-01-15T10:30:00Z
source: https://example.com/article
domain: example.com
language: en
description: "Article description..."
word_count: 1234
---

# Article Content

这里是文章的正文内容...
```

## GitHub Pages 集成

GitHub Pages (`docs/`) 已配置为自动跳转到 Cloudflare Worker。

### 架构

```
GitHub Pages (docs/)
    │
    ▼ (302 redirect)
Cloudflare Worker
    │
    ▼ (fetch)
目标网页
    │
    ▼
返回 Markdown
```

### 本地开发

如果需要在本地开发或修改 GitHub Pages 内容：

```bash
# 直接用浏览器打开 docs/index.html
open docs/index.html

# 或用任意静态服务器
npx serve docs/
```

## 目录结构

```
defuddle/
├── docs/                      # GitHub Pages (自动跳转 Worker)
│   ├── index.html            # 跳转到 Worker
│   ├── redirect.html         # 备用跳转页
│   └── DEPLOYMENT.md         # 本文档
│
├── website-free/              # Cloudflare Worker 源码
│   ├── src/
│   │   ├── index.ts         # Worker 主入口
│   │   ├── polyfill.ts      # linkedom/Turndown 兼容补丁
│   │   ├── defuddle.ts      # 核心解析逻辑
│   │   ├── markdown.ts       # HTML→Markdown 转换
│   │   ├── fetch.ts          # 网页获取
│   │   └── ...
│   ├── wrangler.toml         # Workers 配置
│   └── package.json
│
└── src/                      # 浏览器版本库
    └── ...
```

## 与原版 defuddle.md 的区别

| 功能 | 原版 defuddle.md | website-free |
|------|------------------|--------------|
| API Key | 需要 | 不需要 |
| 付费功能 | Stripe 支付 | 无 |
| Durable Objects | 用于 API Key 余额管理 | 无 |
| KV 存储 | 用于限流 | 仅缓存 |
| 部署 | 需要配置 Stripe/KV/DO | 直接部署 |

## 常见问题

### Q: 部署需要付费吗？
不需要。Cloudflare Workers 免费版每月可处理 100,000 次请求。

### Q: 可以获取 Twitter/X 私信内容吗？
不能。Twitter 私信需要登录认证，Worker 无法访问。

### Q: GitHub Pages 为什么跳转到 Worker？
GitHub Pages 无法执行服务端代码，CORS 代理也不稳定。跳转到 Worker 可以确保：
- 无 CORS 问题
- 支持所有网站（包括 Twitter）
- 完整的 Markdown 转换

### Q: 如何处理需要 JavaScript 渲染的页面？
Defuddle 主要依赖 Server-Side Rendering（SSR）内容。对于纯客户端渲染的页面，可能无法获取完整内容。

## 许可证

MIT License（与上游 Defuddle 项目一致）
