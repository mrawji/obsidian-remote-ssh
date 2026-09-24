#!/bin/bash
# Bring up what the E2E suite assumes, then run whatever was asked of us.
#
# Three things have to exist before Playwright starts, and each one has
# failed in a way that reads as a product bug rather than a missing step:
#
#   - an X server, or Electron exits before Obsidian's window ever appears
#   - `node_modules`, which cannot come from the host (a macOS tree mounted
#     into Linux brings the wrong platform's binaries)
#   - `server-bin/`, without which `scaffoldTestVault` refuses to seed an
#     RPC-transport profile and every spec that uses one fails at setup
set -euo pipefail

log() { echo "[e2e-runner] $*"; }

# ─── X ─────────────────────────────────────────────────────────────────

Xvfb "${DISPLAY}" -screen 0 1280x1024x24 -nolisten tcp &
XVFB_PID=$!
trap 'kill "${XVFB_PID}" 2>/dev/null || true' EXIT

# Xvfb takes a moment to create its socket, and Electron does not retry.
for _ in $(seq 1 50); do
  [ -e "/tmp/.X11-unix/X${DISPLAY#:}" ] && break
  sleep 0.1
done
if [ ! -e "/tmp/.X11-unix/X${DISPLAY#:}" ]; then
  log "Xvfb never created a socket for ${DISPLAY}" >&2
  exit 1
fi
log "X server ready on ${DISPLAY}"

# ─── dependencies, in the container's own tree ─────────────────────────

# `node_modules` lives in a named volume mounted over this path, so it is
# the container's own and survives between runs. An empty volume on first
# use is the only time this costs anything.
if [ ! -x node_modules/.bin/playwright ]; then
  log "installing dependencies (first run in this volume)…"
  npm ci
fi

# Always, never "if missing". The source tree is mounted from the host and
# changes between runs; a cached `main.js` means the suite drives the bundle
# from whenever it was last built and reports on code that is no longer
# there. That cost a full red run once — the fix under test was never in the
# binary being tested.
#
# Both are cheap on a warm cache: esbuild is seconds, and Go's build cache
# lives in a volume so only changed packages recompile.
log "building the daemon…"
npm run build:server

log "building the plugin…"
node esbuild.config.mjs production

log "running: $*"
exec "$@"
