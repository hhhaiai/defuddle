# Defuddle Worker

[defuddle.md](https://defuddle.md) is a Cloudflare Worker that wraps Defuddle as an HTTP API. Pass any URL as the path and it returns the cleaned content:

```bash
curl https://defuddle.md/https://example.com/article
```

## Deployments

### Production Workers

| Name | URL | Description |
|------|-----|-------------|
| defuddle | https://defuddle.877781132.workers.dev | 主站点 |
| defuddle-free | https://defuddle-free.877781132.workers.dev | 免费版 |

### Deploy Commands

```bash
# 部署到主站点
npx wrangler deploy

# 部署到 defuddle-free 子域名
npx wrangler deploy --name defuddle-free
```

## Running locally

Install [Wrangler](https://developers.cloudflare.com/workers/wrangler/), Cloudflare's CLI for Workers:

```bash
npm install -g wrangler
```

Then start the dev server from this directory:

```bash
cd website
npx wrangler dev
```

The Worker imports source from `../src/` directly, so wrangler compiles on the fly. Test it with `curl` (not a browser):

```bash
curl http://localhost:8788/https://example.com/article
```

If source changes don't seem to take effect, clear the wrangler cache:

```bash
rm -rf .wrangler
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/upload-image` | POST | 上传图片到百度图床（浏览器端执行） |
| `/api/parse` | POST | 解析 HTML 为 Markdown |
| `/api/keys` | GET/POST | API 密钥管理 |
| `/html/{url}` | GET | 返回纯 HTML（无编辑器） |
| `/{url}` | GET | 返回编辑器页面（左侧 Markdown，右侧预览） |

## Features

- **编辑器界面**：访问内容 URL 时显示双栏编辑器
  - 左侧：Markdown 编辑器 + 字符计数
  - 右侧：实时渲染预览（支持 LaTeX 数学公式、代码高亮）
  - 顶部：复制 Markdown / 导出 DOCX 按钮

- **图片上传**：导出 DOCX 时自动将图片上传到百度图床
  - 图片上传在浏览器端执行（使用用户 IP）
  - 替换 Markdown 中的图片地址为百度图床地址

## Configuration

- KV Namespace: `RATE_LIMIT`
- Durable Objects: `ApiKeyBalanceDO`, `CheckoutFulfillmentDO`
