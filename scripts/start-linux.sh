#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
OS_NAME="$(uname -s)"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

export NODE_ENV="${NODE_ENV:-production}"
export PORT="${PORT:-81}"
export WORKSPACE="${WORKSPACE:-$ROOT_DIR/workspace}"
export CDP_SEND_TIMEOUT_MS="${CDP_SEND_TIMEOUT_MS:-120000}"
export CDP_READY_TIMEOUT_MS="${CDP_READY_TIMEOUT_MS:-60000}"

RUNTIME_DIR="${RUNTIME_DIR:-$WORKSPACE/.runtime}"
LOG_DIR="${LOG_DIR:-$WORKSPACE/logs}"
PID_FILE="${PID_FILE:-$RUNTIME_DIR/server.pid}"
LOG_FILE="${LOG_FILE:-$LOG_DIR/server.log}"
MAX_RESTARTS="${MAX_RESTARTS:-10}"
RESTART_DELAY="${RESTART_DELAY:-3}"
STARTUP_TIMEOUT_SECONDS="${STARTUP_TIMEOUT_SECONDS:-30}"

log() {
  printf '[start] %s\n' "$*"
}

fail() {
  printf '[start] ERROR: %s\n' "$*" >&2
  exit 1
}

is_macos() {
  [ "$OS_NAME" = "Darwin" ]
}

is_linux() {
  [ "$OS_NAME" = "Linux" ]
}

require_supported_os() {
  is_linux || is_macos || fail "unsupported OS: $OS_NAME (only Linux and macOS are supported)"
}

detect_browser() {
  if [ -n "${CHROMIUM_PATH:-}" ] || [ -n "${CHROME_PATH:-}" ] || [ -n "${BROWSER_PATH:-}" ]; then
    return
  fi

  local candidate
  for candidate in chromium chromium-browser google-chrome google-chrome-stable chrome microsoft-edge microsoft-edge-stable; do
    if command -v "$candidate" >/dev/null 2>&1; then
      export CHROMIUM_PATH="$(command -v "$candidate")"
      return
    fi
  done

  if is_macos; then
    for candidate in \
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
      "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
      if [ -x "$candidate" ]; then
        export CHROMIUM_PATH="$candidate"
        return
      fi
    done
  fi
}

prepare_runtime() {
  require_supported_os
  cd "$ROOT_DIR"
  mkdir -p "$WORKSPACE" "$RUNTIME_DIR" "$LOG_DIR"

  command -v node >/dev/null 2>&1 || fail "node is not installed; run scripts/install-linux.sh first"
  command -v pnpm >/dev/null 2>&1 || fail "pnpm is not installed; run scripts/install-linux.sh first"
  command -v opencode >/dev/null 2>&1 || fail "opencode is not installed; run scripts/install-linux.sh first"

  if [ ! -d "$ROOT_DIR/node_modules" ]; then
    fail "node_modules is missing; run scripts/install-linux.sh first"
  fi

  if [ ! -f "$ROOT_DIR/dist/browser-mcp-server.mjs" ]; then
    log "dist/browser-mcp-server.mjs is missing; building it now"
    pnpm run build:mcp
  fi

  detect_browser
  if [ -z "${CHROMIUM_PATH:-}" ] && [ -z "${CHROME_PATH:-}" ] && [ -z "${BROWSER_PATH:-}" ]; then
    log "warning: no Chrome/Chromium binary found; visual verification will fail until CHROMIUM_PATH is set"
  else
    log "browser: ${CHROMIUM_PATH:-${CHROME_PATH:-${BROWSER_PATH:-unknown}}}"
  fi
}

is_running() {
  [ -f "$PID_FILE" ] || return 1

  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" >/dev/null 2>&1
}

check_health() {
  local url="http://127.0.0.1:${PORT}/transformer/health"

  if command -v curl >/dev/null 2>&1; then
    [ "$(curl -fsS "$url" 2>/dev/null || true)" = "ok" ]
    return
  fi

  node -e '
const http = require("node:http");
const url = process.argv[1];
const req = http.get(url, (res) => {
  let body = "";
  res.setEncoding("utf8");
  res.on("data", (chunk) => { body += chunk; });
  res.on("end", () => process.exit(res.statusCode === 200 && body === "ok" ? 0 : 1));
});
req.on("error", () => process.exit(1));
req.setTimeout(1000, () => req.destroy());
' "$url" >/dev/null 2>&1
}

wait_for_health() {
  local deadline=$((SECONDS + STARTUP_TIMEOUT_SECONDS))

  while [ "$SECONDS" -lt "$deadline" ]; do
    if ! is_running; then
      return 1
    fi

    if check_health; then
      return 0
    fi

    sleep 1
  done

  return 1
}

run_foreground() {
  prepare_runtime

  log "service URL: http://0.0.0.0:${PORT}/transformer"
  log "workspace: $WORKSPACE"
  log "log file: $LOG_FILE"

  local restarts=0
  local child_pid=""
  local stop_requested=0

  terminate() {
    stop_requested=1
    if [ -n "$child_pid" ]; then
      kill "$child_pid" >/dev/null 2>&1 || true
      wait "$child_pid" >/dev/null 2>&1 || true
    fi
    exit 0
  }

  trap terminate INT TERM

  while true; do
    log "starting server (restart count: $restarts)"
    cd "$ROOT_DIR"
    pnpm start &
    child_pid="$!"

    set +e
    wait "$child_pid"
    local exit_code="$?"
    set -e
    child_pid=""

    if [ "$stop_requested" = "1" ]; then
      exit 0
    fi

    if [ "$exit_code" -eq 0 ]; then
      exit 0
    fi

    restarts=$((restarts + 1))
    if [ "$restarts" -ge "$MAX_RESTARTS" ]; then
      log "max restarts ($MAX_RESTARTS) reached, giving up (last exit code: $exit_code)"
      exit "$exit_code"
    fi

    log "server exited with code $exit_code, restarting in ${RESTART_DELAY}s... ($restarts/$MAX_RESTARTS)"
    sleep "$RESTART_DELAY"
  done
}

start_background() {
  prepare_runtime

  if is_running; then
    log "already running (pid $(cat "$PID_FILE"))"
    log "service URL: http://0.0.0.0:${PORT}/transformer"
    return
  fi

  rm -f "$PID_FILE"
  nohup "$SCRIPT_PATH" foreground >>"$LOG_FILE" 2>&1 &
  echo "$!" >"$PID_FILE"

  if wait_for_health; then
    log "started (pid $(cat "$PID_FILE"))"
    log "service URL: http://0.0.0.0:${PORT}/transformer"
    log "logs: $LOG_FILE"
  else
    if is_running; then
      stop_background >/dev/null 2>&1 || true
    fi
    rm -f "$PID_FILE"
    fail "failed to start or health check timed out; see $LOG_FILE"
  fi
}

stop_background() {
  if ! is_running; then
    rm -f "$PID_FILE"
    log "not running"
    return
  fi

  local pid
  pid="$(cat "$PID_FILE")"
  log "stopping pid $pid"
  kill "$pid" >/dev/null 2>&1 || true

  local i
  for i in $(seq 1 20); do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      rm -f "$PID_FILE"
      log "stopped"
      return
    fi
    sleep 0.5
  done

  log "pid $pid did not stop gracefully; sending SIGKILL"
  kill -9 "$pid" >/dev/null 2>&1 || true
  rm -f "$PID_FILE"
}

status() {
  if is_running; then
    log "running (pid $(cat "$PID_FILE"))"
    log "service URL: http://0.0.0.0:${PORT}/transformer"
  else
    rm -f "$PID_FILE"
    log "not running"
  fi
}

usage() {
  cat <<EOF
Usage: scripts/start-linux.sh <command>

Commands:
  start       Start in the background (default)
  foreground  Run in the foreground with restart protection
  stop        Stop background service
  restart     Restart background service
  status      Show service status
  logs        Follow service log

Common env:
  PORT=81
  WORKSPACE=$ROOT_DIR/workspace
  ENV_FILE=$ROOT_DIR/.env
  CHROMIUM_PATH=/usr/bin/chromium
  MAX_CONCURRENT_AGENTS=1
  MAX_PARALLEL_MODULE_AGENTS=3
  MAX_RESTARTS=10
  RESTART_DELAY=3
  STARTUP_TIMEOUT_SECONDS=30
EOF
}

command="${1:-start}"

case "$command" in
  start)
    start_background
    ;;
  foreground | run)
    run_foreground
    ;;
  stop)
    stop_background
    ;;
  restart)
    stop_background
    start_background
    ;;
  status)
    status
    ;;
  logs)
    mkdir -p "$LOG_DIR"
    touch "$LOG_FILE"
    tail -f "$LOG_FILE"
    ;;
  -h | --help | help)
    usage
    ;;
  *)
    usage
    exit 1
    ;;
esac
