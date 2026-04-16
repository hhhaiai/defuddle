#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8787}"
TARGET_PATH="/x.com/mscryptojiayi/status/2044651449339330662"
BASE_URL="http://127.0.0.1:${PORT}"
LOG_FILE="${TMPDIR:-/tmp}/defuddle-free-viewer-test.log"

cleanup() {
  if [[ -n "${DEV_PID:-}" ]] && kill -0 "$DEV_PID" 2>/dev/null; then
    kill "$DEV_PID" 2>/dev/null || true
    wait "$DEV_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

cd "$ROOT_DIR"
npx wrangler dev --port "$PORT" >"$LOG_FILE" 2>&1 &
DEV_PID=$!

for _ in {1..40}; do
  if curl -sSf "${BASE_URL}/" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
 done

nav_headers=$(curl -sSI "${BASE_URL}${TARGET_PATH}" \
  -H 'Accept: */*' \
  -H 'Sec-Fetch-Dest: document' \
  -H 'Sec-Fetch-Mode: navigate' \
  -H 'Sec-Fetch-Site: none' \
  -H 'Upgrade-Insecure-Requests: 1')

browser_headers=$(curl -sSI "${BASE_URL}${TARGET_PATH}" \
  -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8' \
  -H 'Sec-Fetch-Dest: document' \
  -H 'Sec-Fetch-Mode: navigate' \
  -H 'Sec-Fetch-Site: none' \
  -H 'Upgrade-Insecure-Requests: 1')

raw_headers=$(curl -sSI "${BASE_URL}${TARGET_PATH}?raw=1" \
  -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8' \
  -H 'Sec-Fetch-Dest: document' \
  -H 'Sec-Fetch-Mode: navigate' \
  -H 'Sec-Fetch-Site: none' \
  -H 'Upgrade-Insecure-Requests: 1')

printf '%s\n' '--- nav_headers ---' "$nav_headers"
printf '%s\n' '--- browser_headers ---' "$browser_headers"
printf '%s\n' '--- raw_headers ---' "$raw_headers"

if ! grep -qi '^Content-Type: text/html; charset=utf-8' <<<"$nav_headers"; then
  echo 'FAIL: navigation-style request with Accept: */* should return HTML viewer.' >&2
  exit 1
fi

if ! grep -qi '^Content-Type: text/html; charset=utf-8' <<<"$browser_headers"; then
  echo 'FAIL: browser Accept header should return HTML viewer.' >&2
  exit 1
fi

if ! grep -qi '^Content-Type: text/markdown; charset=utf-8' <<<"$raw_headers"; then
  echo 'FAIL: ?raw=1 should force markdown response.' >&2
  exit 1
fi
