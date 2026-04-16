#!/usr/bin/env bash
set -euo pipefail

MOCK_PORT="${MOCK_PORT:-9912}"
WORKER_PORT="${WORKER_PORT:-8792}"
PERSIST_DIR="$(mktemp -d ${TMPDIR:-/tmp}/defuddle-free-docx-persist.XXXXXX)"
MOCK_JS="${TMPDIR:-/tmp}/defuddle-free-docx-mock-server.mjs"
MOCK_LOG="${TMPDIR:-/tmp}/defuddle-free-docx-mock.log"
WORKER_LOG="${TMPDIR:-/tmp}/defuddle-free-docx-worker.log"
TARGET_PAGE="http://127.0.0.1:${MOCK_PORT}/page"
ENCODED_TARGET_PATH="/$(python3 - <<PY
import urllib.parse
print(urllib.parse.quote('${TARGET_PAGE}', safe=''))
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
  rm -rf "$PERSIST_DIR"
  rm -f "$MOCK_JS"
}
trap cleanup EXIT

cat > "$MOCK_JS" <<'NODE'
import http from 'node:http';
const port = Number(process.env.MOCK_PORT || 9912);
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
  if (pathname === '/page') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!DOCTYPE html><html><body><article><h1>Docx Export Test</h1><p>Hello <strong>world</strong>.</p><ul><li>One</li><li>Two</li></ul></article></body></html>');
    return;
  }
  res.writeHead(404).end('not found');
});
server.listen(port, '127.0.0.1');
NODE

MOCK_PORT="$MOCK_PORT" node "$MOCK_JS" >"$MOCK_LOG" 2>&1 &
MOCK_PID=$!

for _ in {1..40}; do
  if curl -sSf "http://127.0.0.1:${MOCK_PORT}/page" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
 done

cd /Users/sanbo/Desktop/defuddle/website-free
npx wrangler dev --port "$WORKER_PORT" --persist-to "$PERSIST_DIR" >"$WORKER_LOG" 2>&1 &
WORKER_PID=$!

for _ in {1..60}; do
  if curl -sSf "http://127.0.0.1:${WORKER_PORT}/" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
 done

viewer_html=$(curl -sS "http://127.0.0.1:${WORKER_PORT}${ENCODED_TARGET_PATH}" \
  -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8' \
  -H 'Sec-Fetch-Dest: document' \
  -H 'Sec-Fetch-Mode: navigate' \
  -H 'Sec-Fetch-Site: none' \
  -H 'Upgrade-Insecure-Requests: 1')

printf '%s\n' '--- docx export checks ---'
printf '%s\n' "$viewer_html" | rg -n 'docx\.umd\.js|FileSaver\.min\.js|Packer\.toBlob|\.docx|application/msword|\.doc\b' -n -S || true

if ! grep -Fq '/vendor/docx.umd.js' <<<"$viewer_html"; then
  echo 'FAIL: viewer must load /vendor/docx.umd.js for true docx export.' >&2
  exit 1
fi

if ! grep -Fq 'window.docx.Packer.toBlob' <<<"$viewer_html"; then
  echo 'FAIL: viewer must use window.docx.Packer.toBlob for true docx export.' >&2
  exit 1
fi

if ! grep -Fq ".docx'" <<<"$viewer_html"; then
  echo 'FAIL: viewer must download a .docx file.' >&2
  exit 1
fi

if grep -Fq 'application/msword' <<<"$viewer_html"; then
  echo 'FAIL: viewer must not use legacy application/msword export path.' >&2
  exit 1
fi
