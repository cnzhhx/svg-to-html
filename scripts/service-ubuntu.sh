#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-/etc/svg-to-html/app.env}"
SERVICE_NAME="${SVG_TO_HTML_SERVICE_NAME:-svg-to-html}"

require_root() {
  [ "$(id -u)" -eq 0 ] || {
    printf 'Run with sudo: sudo bash scripts/service-ubuntu.sh %s\n' "${1:-status}" >&2
    exit 1
  }
}

load_runtime_config() {
  [ -f "$ENV_FILE" ] || {
    printf 'Missing deployment config: %s\n' "$ENV_FILE" >&2
    exit 1
  }
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  export SVG_TRANSFORM_CORE_MODEL_CONFIG="${SVG_TRANSFORM_CORE_MODEL_CONFIG:-$(dirname "$ENV_FILE")/model-provider.json}"
}

wait_gateway() {
  local url="http://127.0.0.1:${PORT:-8081}/transformer/health"
  for _ in $(seq 1 30); do
    if curl --max-time 2 -fsS "$url" 2>/dev/null | grep -qx 'ok'; then
      printf 'Gateway healthy: %s\n' "$url"
      return
    fi
    sleep 1
  done
  printf 'Gateway health check timed out: %s\n' "$url" >&2
  exit 1
}

run_core() {
  env \
    ENV_FILE="$ENV_FILE" \
    SVG_TRANSFORM_CORE_MODEL_CONFIG="$SVG_TRANSFORM_CORE_MODEL_CONFIG" \
    bash "$ROOT_DIR/scripts/core-docker.sh" "$@"
}

usage() {
  cat <<USAGE
Usage: scripts/service-ubuntu.sh <command>

Commands:
  status    Show gateway and core status
  restart   Restart core and gateway
  update    Rebuild the project and redeploy the configured core image
  logs      Follow gateway logs
  core-logs Follow core container logs
  health    Check core, gateway, and Nginx endpoints
USAGE
}

command="${1:-status}"
case "$command" in
  help | --help | -h)
    usage
    exit 0
    ;;
esac
require_root "$command"
case "$command" in
  status)
    load_runtime_config
    systemctl status "$SERVICE_NAME" --no-pager
    run_core status
    ;;
  restart)
    load_runtime_config
    run_core recreate
    systemctl restart "$SERVICE_NAME"
    wait_gateway
    ;;
  update)
    env \
      ENV_FILE="$ENV_FILE" \
      SVG_TO_HTML_SERVICE_NAME="$SERVICE_NAME" \
      bash "$ROOT_DIR/scripts/deploy-ubuntu.sh"
    ;;
  logs)
    journalctl -u "$SERVICE_NAME" -f
    ;;
  core-logs)
    load_runtime_config
    run_core logs
    ;;
  health)
    load_runtime_config
    run_core health
    curl --max-time 3 -fsS "http://127.0.0.1:${PORT:-8081}/transformer/health"
    printf '\n'
    curl --max-time 3 -fsS "http://127.0.0.1/transformer/health"
    printf '\n'
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac
