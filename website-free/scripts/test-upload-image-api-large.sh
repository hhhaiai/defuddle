#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MOCK_PORT="${MOCK_PORT:-9922}"
WORKER_PORT="${WORKER_PORT:-8794}"
MOCK_LOG="${TMPDIR:-/tmp}/defuddle-free-large-mock.log"
WORKER_LOG="${TMPDIR:-/tmp}/defuddle-free-large-worker.log"
PERSIST_DIR="$(mktemp -d ${TMPDIR:-/tmp}/defuddle-free-large-persist.XXXXXX)"
MOCK_JS="${TMPDIR:-/tmp}/defuddle-free-large-mock-server.mjs"
EXPECTED_BAIDU_URL="https://edit-upload-pic.cdn.bcebos.com/mock-large-uploaded.jpg"

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

const port = Number(process.env.MOCK_PORT || 9922);
const largeBuffer = Buffer.alloc(300000, 0xff);

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end('missing url');
    return;
  }
  const pathname = new URL(req.url, `http://127.0.0.1:${port}`).pathname;

  if (pathname === '/large.jpg') {
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': String(largeBuffer.length) });
    res.end(largeBuffer);
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
    res.end(JSON.stringify({ data: { url: 'https://edit-upload-pic.cdn.bcebos.com/mock-large-uploaded.jpg' } }));
    return;
  }

  res.writeHead(404).end('not found');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock large server listening on http://127.0.0.1:${port}`);
});
NODE

MOCK_PORT="$MOCK_PORT" node "$MOCK_JS" >"$MOCK_LOG" 2>&1 &
MOCK_PID=$!

for _ in {1..40}; do
  if curl -sSf "http://127.0.0.1:${MOCK_PORT}/large.jpg" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

cd "$ROOT_DIR"
npx wrangler dev --config "$ROOT_DIR/wrangler.toml" --port "$WORKER_PORT" --persist-to "$PERSIST_DIR" --var "BAIDU_UPLOAD_ENDPOINT:http://127.0.0.1:${MOCK_PORT}/baidu" >"$WORKER_LOG" 2>&1 &
WORKER_PID=$!

for _ in {1..60}; do
  if curl -sSf "http://127.0.0.1:${WORKER_PORT}/" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

response=$(curl -sS "http://127.0.0.1:${WORKER_PORT}/api/upload-image" \
  -H 'Content-Type: application/json' \
  --data '{"url":"http://127.0.0.1:9922/large.jpg"}')

printf '%s\n' '--- api response ---' "$response"

if ! grep -Fq "$EXPECTED_BAIDU_URL" <<<"$response"; then
  echo 'FAIL: upload-image API should upload large images without crashing base64 conversion.' >&2
  echo '--- worker log ---' >&2
  tail -n 80 "$WORKER_LOG" >&2 || true
  exit 1
fi
