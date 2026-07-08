#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
DEFAULT_CORE_REPO="$ROOT_DIR/../svg-transform-core"

fail() {
  printf '[core-docker] ERROR: %s\n' "$*" >&2
  exit 1
}

read_env_value() {
  local key="$1"
  [ -f "$ENV_FILE" ] || return 0

  local line env_key value
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [ -n "$line" ] || continue
    case "$line" in \#*) continue ;; esac

    env_key="${line%%=*}"
    [ "$env_key" != "$line" ] || continue
    env_key="${env_key%"${env_key##*[![:space:]]}"}"
    [ "$env_key" = "$key" ] || continue

    value="${line#*=}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    value="${value%\"}"
    value="${value#\"}"
    value="${value%\'}"
    value="${value#\'}"
    printf '%s\n' "$value"
    return 0
  done <"$ENV_FILE"
}

resolve_core_port() {
  if [ -n "${SVG_TRANSFORM_CORE_PORT:-}" ]; then
    printf '%s\n' "$SVG_TRANSFORM_CORE_PORT"
    return
  fi

  local core_url="${SVG_TRANSFORM_CORE_URL:-}"
  if [ -z "$core_url" ]; then
    core_url="$(read_env_value SVG_TRANSFORM_CORE_URL || true)"
  fi

  if [[ "$core_url" =~ :([0-9]+)(/.*)?$ ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
    return
  fi

  printf '4310\n'
}

docker_core_port_is_running() {
  command -v docker >/dev/null 2>&1 || return 1
  docker info >/dev/null 2>&1 || return 1

  local published
  published="$(docker ps \
    --filter "ancestor=${SVG_TRANSFORM_CORE_IMAGE:-svg-transform-core:local}" \
    --format '{{.Names}} {{.Ports}}' | grep -E "(0\.0\.0\.0|127\.0\.0\.1|::):${CORE_PORT}->4310/tcp" || true)"
  [ -n "$published" ] || return 1

  curl --max-time 3 -fsS "http://127.0.0.1:$CORE_PORT/health" >/dev/null 2>&1
}

CORE_REPO="${SVG_TRANSFORM_CORE_REPO:-$DEFAULT_CORE_REPO}"
CORE_REPO="$(cd "$CORE_REPO" 2>/dev/null && pwd)" || fail "svg-transform-core repo not found: $CORE_REPO
Set SVG_TRANSFORM_CORE_REPO=/absolute/path/to/svg-transform-core if it is not next to this repo."

CORE_SCRIPT="$CORE_REPO/scripts/docker-core.sh"
[ -f "$CORE_SCRIPT" ] || fail "core Docker helper not found: $CORE_SCRIPT"

CORE_MODEL_CONFIG="${SVG_TRANSFORM_CORE_MODEL_CONFIG:-$CORE_REPO/.runtime/model-provider.json}"
if [ ! -f "$CORE_MODEL_CONFIG" ]; then
  fail "core model config not found: $CORE_MODEL_CONFIG
Create and fill it first:
  cd \"$CORE_REPO\"
  mkdir -p .runtime
  cp apps/server/config/model-provider.example.json .runtime/model-provider.json"
fi

CORE_PORT="$(resolve_core_port)"
export PORT="$CORE_PORT"
export SVG_TRANSFORM_CORE_MODEL_CONFIG="$CORE_MODEL_CONFIG"

if [ "${1:-start}" = "start" ] && docker_core_port_is_running; then
  printf '[core-docker] core Docker already serves http://127.0.0.1:%s/health\n' "$CORE_PORT"
  exit 0
fi

cd "$CORE_REPO"
exec bash "$CORE_SCRIPT" "${1:-start}"
