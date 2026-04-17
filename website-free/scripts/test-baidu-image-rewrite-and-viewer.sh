#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MOCK_PORT="${MOCK_PORT:-9911}"
MOCK_LOG="${TMPDIR:-/tmp}/defuddle-free-baidu-mock.log"
MOCK_JS="${TMPDIR:-/tmp}/defuddle-free-baidu-mock-server.mjs"
MOCK_IMAGE_URL="http://127.0.0.1:${MOCK_PORT}/test.png"
MOCK_BAIDU_URL="http://127.0.0.1:${MOCK_PORT}/baidu"
EXPECTED_BAIDU_URL="https://edit-upload-pic.cdn.bcebos.com/mock-uploaded.png"

cleanup() {
  if [[ -n "${MOCK_PID:-}" ]] && kill -0 "$MOCK_PID" 2>/dev/null; then
    kill "$MOCK_PID" 2>/dev/null || true
    wait "$MOCK_PID" 2>/dev/null || true
  fi
  rm -f "$MOCK_JS"
}
trap cleanup EXIT

cat > "$MOCK_JS" <<'NODE'
import http from 'node:http';

const port = Number(process.env.MOCK_PORT || 9911);
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7W0AAAAASUVORK5CYII=';
const pngBuffer = Buffer.from(pngBase64, 'base64');

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end('missing url');
    return;
  }

  const pathname = new URL(req.url, `http://127.0.0.1:${port}`).pathname;

  if (pathname === '/test.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(pngBuffer.length) });
    res.end(pngBuffer);
    return;
  }

  if (pathname === '/baidu' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = new URLSearchParams(body);
    if (!payload.get('token') || !payload.get('picInfo')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing token or picInfo' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: { url: 'https://edit-upload-pic.cdn.bcebos.com/mock-uploaded.png' } }));
    return;
  }

  res.writeHead(404).end('not found');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock server listening on http://127.0.0.1:${port}`);
});
NODE

MOCK_PORT="$MOCK_PORT" node "$MOCK_JS" >"$MOCK_LOG" 2>&1 &
MOCK_PID=$!

for _ in {1..40}; do
  if curl -sSf "http://127.0.0.1:${MOCK_PORT}/test.png" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

cd "$ROOT_DIR"

MOCK_IMAGE_URL="$MOCK_IMAGE_URL" MOCK_BAIDU_URL="$MOCK_BAIDU_URL" EXPECTED_BAIDU_URL="$EXPECTED_BAIDU_URL" \
  npx tsx <<'NODE'
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
const require = createRequire(import.meta.url);
const { getMarkdownViewerPage } = require('./src/index.ts');

const mockImageUrl = process.env.MOCK_IMAGE_URL!;
const mockBaiduUrl = process.env.MOCK_BAIDU_URL!;
const expectedBaiduUrl = process.env.EXPECTED_BAIDU_URL!;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(str: string) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const markdown = `---\ntitle: "Mock article"\nsource: "http://127.0.0.1:9911/page"\n---\n\n![Mock](${mockImageUrl})`;
const html = getMarkdownViewerPage(markdown, {
  title: 'Mock article',
  source: 'http://127.0.0.1:9911/page',
  domain: '127.0.0.1',
  language: 'zh-CN'
}, {
  baiduUploadEndpoint: mockBaiduUrl
});

const dom = new JSDOM(html, {
  url: 'https://defuddle-free.example/http://127.0.0.1:9911/page',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(window) {
    const originalFetch = global.fetch.bind(global);
    window.fetch = (input, init) => {
      const rawUrl =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input?.url;
      if (rawUrl === '/api/upload-image' || rawUrl?.endsWith('/api/upload-image')) {
        return Promise.resolve(new Response(JSON.stringify({ url: expectedBaiduUrl }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }));
      }
      const normalizedInput =
        typeof input === 'string' && input.startsWith('/')
          ? new URL(input, window.location.href).toString()
          : input;
      return originalFetch(normalizedInput, init);
    };
    window.AbortSignal = global.AbortSignal as typeof window.AbortSignal;
    window.TextEncoder = global.TextEncoder as typeof window.TextEncoder;
    window.TextDecoder = global.TextDecoder as typeof window.TextDecoder;
    window.btoa = (str: string) => Buffer.from(str, 'binary').toString('base64');
    window.atob = (str: string) => Buffer.from(str, 'base64').toString('binary');
    window.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number;
    window.cancelAnimationFrame = (id: number) => clearTimeout(id);
    window.markdownit = () => ({
      render(src: string) {
        return `<pre>${escapeHtml(src)}</pre>`;
      }
    });
    window.hljs = {
      getLanguage() { return false; },
      highlight(str: string) { return { value: escapeHtml(str) }; }
    };
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: {
        async writeText(text: string) {
          (window as any).__copiedText = text;
        }
      }
    });
  }
});

const { window } = dom;
await sleep(120);

const mdInput = window.document.getElementById('md-input') as HTMLTextAreaElement | null;
const preview = window.document.getElementById('md-preview');
if (!mdInput) throw new Error('missing md-input textarea');
if (!preview) throw new Error('missing md-preview');

if (mdInput.hasAttribute('readonly')) {
  throw new Error('viewer markdown textarea should be editable, but readonly is still present');
}

let replaced = false;
for (let i = 0; i < 40; i++) {
  if (mdInput.value.includes(expectedBaiduUrl)) {
    replaced = true;
    break;
  }
  await sleep(250);
}
if (!replaced) {
  throw new Error('viewer should asynchronously replace markdown image URL with uploaded Baidu URL');
}
if (mdInput.value.includes(mockImageUrl)) {
  throw new Error('viewer markdown should not keep original image URL after successful async upload');
}

mdInput.value += '\n\n删除测试';
mdInput.dispatchEvent(new window.Event('input', { bubbles: true }));
await sleep(250);
if (!preview.textContent?.includes('删除测试')) {
  throw new Error('preview should update after editing markdown textarea');
}

const fakeButton = window.document.createElement('button');
fakeButton.textContent = '复制';
await (window as any).copyMarkdown({ currentTarget: fakeButton, target: fakeButton });
if (!String((window as any).__copiedText || '').includes('删除测试')) {
  throw new Error('copyMarkdown should copy the current edited markdown content');
}
NODE
