# Defuddle Cloudflare Worker 部署指南

## 概述

这是一个简化版的 Defuddle 服务，部署在 Cloudflare Workers 上，可以将任意网页转换为干净的 Markdown 格式。

**在线演示：** https://defuddle-free.877781132.workers.dev

## 功能

- 将网页 URL 转换为 Markdown 格式
- 将网页 URL 转换为 HTML 格式（使用 `/html/` 前缀）
- 支持 YouTube、GitHub、Reddit 等网站专用提取器
- 无需 API Key，完全免费使用
- 服务端获取，无 CORS 跨域问题

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
https://defuddle-free.877781132.workers.dev
```

## 使用方法

### 基本格式

```
https://你的-worker.workers.dev/https://目标URL
```

### 示例

```bash
# 转换网页为 Markdown
curl https://defuddle-free.877781132.workers.dev/https://stephango.com/saw

# 转换 Twitter 帖子
curl https://defuddle-free.877781132.workers.dev/https://x.com/op7418/status/2044634498432962806

# 获取 HTML 格式（而非 Markdown）
curl https://defuddle-free.877781132.workers.dev/html/https://example.com/article
```

### 在浏览器中使用

直接在浏览器访问上述 URL，会返回转换后的内容。

### Bookmarklet（书签脚本）

将以下代码拖拽到书签栏：

```javascript
javascript:void(location.href='https://defuddle-free.877781132.workers.dev/'+location.href.replace(/^https?:\/\//,''))
```

点击书签栏中的链接，会跳转到转换后的页面。

## 自定义域名

### 在 Cloudflare Dashboard 中设置

1. 进入 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 选择你的 Worker（`defuddle-free`）
3. 进入 **Settings** → **Triggers**
4. 在 **Custom Domains** 部分点击 **Add Custom Domain**
5. 输入你的域名（如 `defuddle.yourdomain.com`）

### 使用你自己的 Workers URL

如果使用自己的域名，请更新 `src/index.ts` 中的 `PRIMARY_HOST` 常量：

```typescript
const PRIMARY_HOST = 'defuddle.yourdomain.com'; // 改成你的域名
```

重新部署后，bookmarklet 和内部链接会使用新域名。

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

1. 用户请求 `https://worker-url/https://example.com/article`
2. Worker 解析 URL，从路径中提取目标网址
3. Worker 使用 `fetch()` 在服务端获取目标网页（无 CORS 限制）
4. 使用 Defuddle 库提取主要内容
5. 使用 Turndown 将 HTML 转换为 Markdown
6. 返回带 YAML frontmatter 的 Markdown

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

如果你想在 GitHub Pages 上托管一个前端页面，可以通过以下方式集成：

### 方式一：使用 Worker URL

在 GitHub Pages 页面中使用 Worker 作为 API：

```javascript
const API_URL = 'https://defuddle-free.877781132.workers.dev';
const targetUrl = 'https://example.com/article';

fetch(`${API_URL}/${targetUrl}`)
  .then(r => r.text())
  .then(markdown => {
    console.log(markdown);
  });
```

### 方式二：302 重定向到 Worker

如果希望 `https://your-site.github.io/defuddle/` 自动跳转到 Worker，可以使用 meta refresh：

在 `docs/index.html` 开头添加：

```html
<!-- 3秒后跳转到 Worker -->
<meta http-equiv="refresh" content="3;url=https://defuddle-free.877781132.workers.dev/">
```

或在文档根目录创建 `redirect.html`：

```html
<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="refresh" content="0;url=https://defuddle-free.877781132.workers.dev/">
</head>
<body>
  <p>正在跳转到 Defuddle Worker...</p>
  <p><a href="https://defuddle-free.877781132.workers.dev/">点击这里</a></p>
</body>
</html>
```

## 目录结构

```
website-free/
├── src/
│   ├── index.ts          # Worker 主入口
│   ├── polyfill.ts       # linkedom/Turndown 兼容补丁
│   ├── defuddle.ts       # 核心解析逻辑
│   ├── markdown.ts       # HTML→Markdown 转换
│   ├── fetch.ts          # 网页获取
│   ├── standardize.ts    # HTML 标准化
│   ├── constants.ts      # 选择器和配置
│   ├── types.ts          # TypeScript 类型定义
│   ├── metadata.ts       # 元数据提取
│   ├── elements/         # 元素处理（ footnotes, callouts, code, images, math）
│   ├── extractors/       # 网站专用提取器（github, reddit, youtube, twitter 等）
│   ├── removals/         # 内容清理（ selectors, hidden, scoring 等）
│   └── utils/            # 工具函数
├── wrangler.toml         # Workers 配置
├── package.json
└── tsconfig.json
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

### Q: 如何处理需要 JavaScript 渲染的页面？
Defuddle 主要依赖 Server-Side Rendering（SSR）内容。对于纯客户端渲染的页面，可能无法获取完整内容。

### Q: 请求频率限制？
Cloudflare Workers 免费版没有明确的频率限制，但建议添加缓存以减少重复请求。

## 许可证

MIT License（与上游 Defuddle 项目一致）
