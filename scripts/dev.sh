#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

log() {
  printf '[dev] %s\n' "$*"
}

warn() {
  printf '[dev] WARN: %s\n' "$*" >&2
}

fail() {
  printf '[dev] ERROR: %s\n' "$*" >&2
  exit 1
}

run_pnpm() {
  command -v pnpm >/dev/null 2>&1 || fail "pnpm is required. Install it first: npm install -g pnpm@10.11.0"
  pnpm "$@"
}

resolve_host_path() {
  local value="$1"
  case "$value" in
    /*) printf '%s\n' "$value" ;;
    *) printf '%s\n' "$ROOT_DIR/${value#./}" ;;
  esac
}

prepare_config() {
  if [ ! -f "$ENV_FILE" ]; then
    log "creating .env from .env.example"
    cp "$ROOT_DIR/.env.example" "$ENV_FILE"
  fi

  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a

  local model_config
  model_config="$(resolve_host_path "${SVG_TRANSFORM_CORE_MODEL_CONFIG:-$ROOT_DIR/backend/config/model-provider.json}")"
  if [ ! -f "$model_config" ]; then
    log "creating model provider config from example: $model_config"
    mkdir -p "$(dirname "$model_config")"
    cp "$ROOT_DIR/backend/config/model-provider.example.json" "$model_config"
  fi

  if grep -q '"your-model"\|"api.example.com"\|"your-api-key"\|"YOUR_PROVIDER_API_KEY"' "$model_config"; then
    warn "model provider config still contains placeholders: $model_config"
    warn "The UI can start, but real conversions need a valid model provider config."
  fi
}

ensure_dependencies() {
  if [ -d "$ROOT_DIR/node_modules" ] && [ -d "$ROOT_DIR/backend/node_modules" ] && [ -d "$ROOT_DIR/frontend/node_modules" ]; then
    return
  fi

  log "node_modules missing, installing dependencies"
  run_pnpm install
}

main() {
  cd "$ROOT_DIR"
  prepare_config
  ensure_dependencies

  log "starting svg-transform-core Docker service"
  bash "$ROOT_DIR/scripts/core-docker.sh" start

  log "frontend: http://localhost:5173/transformer"
  log "backend:  http://localhost:${PORT:-8081}/transformer"

  command -v pnpm >/dev/null 2>&1 || fail "pnpm is required. Install it first: npm install -g pnpm@10.11.0"
  exec pnpm --parallel --stream --filter @svg-to-html/backend --filter @svg-to-html/frontend run dev
}

main "$@"
