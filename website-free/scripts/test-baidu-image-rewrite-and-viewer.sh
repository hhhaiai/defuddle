#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MOCK_PORT="${MOCK_PORT:-9911}"
WORKER_PORT="${WORKER_PORT:-8791}"
MOCK_LOG="${TMPDIR:-/tmp}/defuddle-free-baidu-mock.log"
WORKER_LOG="${TMPDIR:-/tmp}/defuddle-free-baidu-worker.log"
PERSIST_DIR="$(mktemp -d ${TMPDIR:-/tmp}/defuddle-free-baidu-persist.XXXXXX)"
MOCK_JS="${TMPDIR:-/tmp}/defuddle-free-baidu-mock-server.mjs"
MOCK_IMAGE_URL="http://127.0.0.1:${MOCK_PORT}/test.png"
MOCK_PAGE_URL="http://127.0.0.1:${MOCK_PORT}/page"
MOCK_BAIDU_URL="http://127.0.0.1:${MOCK_PORT}/baidu"
EXPECTED_BAIDU_URL="https://edit-upload-pic.cdn.bcebos.com/mock-uploaded.png"
ENCODED_TARGET_PATH="/$(python3 - <<PY
import urllib.parse
print(urllib.parse.quote('${MOCK_PAGE_URL}', safe=''))
PY
)"

cleanup() {
  if [[ -n "${WORKER_PID:-}" ]] && kill -0 "$WORKER_PID" 2>/dev/null; then
    kill "$WORKER_PID" 2>/dev/null || true
    wait "$WORKER_PID" 2>/dev/null || true
  fi
  if [[ -n "${MOCK_PID:-}" ]] && kill -0 "$MOCK_PID" 2>/dev/null; then
    kill "$MOCK_PID" 2>/dev/null || true
    wait "$MOCK_PID" 2>/dev/null || true
  fi
  rm -f "$MOCK_JS"
  rm -rf "$PERSIST_DIR"
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

  if (pathname === '/page') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><body><article><h1>Mock article</h1><p>Hello image rewrite</p><img src="http://127.0.0.1:${port}/test.png" alt="Mock"></article></body></html>`);
    return;
  }

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
  if curl -sSf "http://127.0.0.1:${MOCK_PORT}/page" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
 done

cd "$ROOT_DIR"
npx wrangler dev --port "$WORKER_PORT" --persist-to "$PERSIST_DIR" --var "BAIDU_UPLOAD_ENDPOINT:${MOCK_BAIDU_URL}" >"$WORKER_LOG" 2>&1 &
WORKER_PID=$!

for _ in {1..60}; do
  if curl -sSf "http://127.0.0.1:${WORKER_PORT}/" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
 done

raw_body=$(curl -sS "http://127.0.0.1:${WORKER_PORT}${ENCODED_TARGET_PATH}?raw=1")

printf '%s\n' '--- raw body ---' "$raw_body"

if ! grep -Fq "$EXPECTED_BAIDU_URL" <<<"$raw_body"; then
  echo 'FAIL: raw markdown should replace image URL with uploaded Baidu URL.' >&2
  exit 1
fi

if grep -Fq "$MOCK_IMAGE_URL" <<<"$raw_body"; then
  echo 'FAIL: raw markdown should not keep original image URL after upload.' >&2
  exit 1
fi

viewer_html=$(curl -sS "http://127.0.0.1:${WORKER_PORT}${ENCODED_TARGET_PATH}" \
  -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8' \
  -H 'Sec-Fetch-Dest: document' \
  -H 'Sec-Fetch-Mode: navigate' \
  -H 'Sec-Fetch-Site: none' \
  -H 'Upgrade-Insecure-Requests: 1')

printf '%s\n' '--- viewer html head ---' "$(printf '%s' "$viewer_html" | sed -n '1,80p')"

if ! grep -Fq 'id="copy-markdown-btn"' <<<"$viewer_html"; then
  echo 'FAIL: viewer should render a copy button inside the markdown pane header.' >&2
  exit 1
fi

if ! grep -Fq 'id="export-word-btn"' <<<"$viewer_html"; then
  echo 'FAIL: viewer should render a Word export button inside the preview pane header.' >&2
  exit 1
fi
if ! grep -Fq 'title: "Mock article"' <<<"$viewer_html"; then
  echo 'FAIL: viewer markdown pane should include frontmatter title.' >&2
  exit 1
fi

if ! grep -Fq 'source: "http://127.0.0.1:9911/page"' <<<"$viewer_html"; then
  echo 'FAIL: viewer markdown pane should include quoted frontmatter source.' >&2
  exit 1
fi
