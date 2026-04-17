# website-free 百度图片托管与详情页按钮重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 website-free 在服务端把正文图片改写为百度地址，并把详情页按钮移动到左右分栏头部。

**Architecture:** 在 HTML→Markdown 之前重写正文 HTML 中的图片 `src`，这样 raw markdown、viewer、导出共用同一份内容。前端 viewer 只做布局与导出交互，不承担图片上传逻辑。

**Tech Stack:** Cloudflare Workers, TypeScript, fetch, node:crypto (MD5), bash 回归脚本

---

### Task 1: 写图片托管失败回归脚本

**Files:**
- Create: `website-free/scripts/test-baidu-image-rewrite-and-viewer.sh`

- [ ] **Step 1: 写失败回归脚本**
- [ ] **Step 2: 运行脚本，确认在实现前失败**

### Task 2: 实现百度图片上传与 HTML 图片改写

**Files:**
- Create: `website-free/src/image-hosting.ts`
- Modify: `website-free/src/index.ts`

- [ ] **Step 1: 添加最小实现接口与环境变量读取**
- [ ] **Step 2: 接入 HTML 图片 URL 替换**
- [ ] **Step 3: 运行回归脚本，确认图片 URL 已替换**

### Task 3: 调整 viewer 按钮布局与 Word 下载

**Files:**
- Modify: `website-free/src/index.ts`
- Modify: `website-free/scripts/test-baidu-image-rewrite-and-viewer.sh`

- [ ] **Step 1: 将复制按钮移到 Markdown pane header**
- [ ] **Step 2: 将 Word 按钮移到 preview pane header**
- [ ] **Step 3: 改为直接下载 `.doc` 文件**
- [ ] **Step 4: 扩展脚本校验按钮位置与导出按钮存在**

### Task 4: 部署与线上验证

**Files:**
- Modify: `website-free/README.md`（如有必要）

- [ ] **Step 1: 运行本地回归脚本**
- [ ] **Step 2: 部署 Worker**
- [ ] **Step 3: 对目标线上链接做浏览器头验证**
