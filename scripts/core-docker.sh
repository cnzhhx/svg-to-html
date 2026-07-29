#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

CONTAINER_NAME="${SVG_TRANSFORM_CORE_CONTAINER:-svg-transform-core}"
IMAGE_NAME="${SVG_TRANSFORM_CORE_IMAGE:-ghcr.io/cnzhhx/svg-transform-core:latest}"
PORT="${SVG_TRANSFORM_CORE_PORT:-}"
WORKSPACE_DIR="${SVG_TRANSFORM_CORE_WORKSPACE:-$ROOT_DIR/workspace/core}"
MODEL_CONFIG="${SVG_TRANSFORM_CORE_MODEL_CONFIG:-$ROOT_DIR/backend/config/model-provider.json}"
CORE_ENV_FILE="${SVG_TRANSFORM_CORE_ENV_FILE:-}"
SPEC_LABEL="svg-to-html.core-spec"

log() {
  printf '[core-docker] %s\n' "$*"
}

fail() {
  printf '[core-docker] ERROR: %s\n' "$*" >&2
  exit 1
}

resolve_host_path() {
  local value="$1"
  [ -n "$value" ] || return 0
  case "$value" in
    /*) printf '%s\n' "$value" ;;
    *) printf '%s\n' "$ROOT_DIR/${value#./}" ;;
  esac
}

resolve_core_port() {
  if [ -n "$PORT" ]; then
    printf '%s\n' "$PORT"
    return
  fi

  local core_url="${SVG_TRANSFORM_CORE_URL:-}"
  if [[ "$core_url" =~ :([0-9]+)(/.*)?$ ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
    return
  fi

  printf '4310\n'
}

spec_hash() {
  local env_file_hash="-"
  if [ -n "$CORE_ENV_FILE" ] && [ -f "$CORE_ENV_FILE" ]; then
    env_file_hash="$(cksum <"$CORE_ENV_FILE" | awk '{print $1}')"
  fi
  # Bump the leading version when docker run flags change so old containers get recreated.
  printf '%s\n' "3|$IMAGE_NAME|$CORE_PORT|$WORKSPACE_DIR|$MODEL_CONFIG|$CORE_ENV_FILE|$env_file_hash" | cksum | awk '{print $1}'
}

health_url() {
  printf 'http://127.0.0.1:%s/health\n' "$CORE_PORT"
}

ensure_docker() {
  command -v docker >/dev/null 2>&1 || fail "docker command not found"
  docker info >/dev/null 2>&1 || fail "Docker daemon is not running"
}

ensure_curl() {
  command -v curl >/dev/null 2>&1 || fail "curl is required for health checks"
}

ensure_image() {
  docker image inspect "$IMAGE_NAME" >/dev/null 2>&1 || {
    log "image $IMAGE_NAME not found, pulling..."
    docker pull "$IMAGE_NAME"
  }
}

pull_image() {
  log "pulling image: $IMAGE_NAME"
  docker pull "$IMAGE_NAME"
}

ensure_runtime_files() {
  mkdir -p "$WORKSPACE_DIR"
  if [ ! -f "$MODEL_CONFIG" ]; then
    fail "core model config not found: $MODEL_CONFIG
Create and fill it first, for example:
  mkdir -p \"$ROOT_DIR/backend/config\"
  cp \"$ROOT_DIR/backend/config/model-provider.example.json\" \"$MODEL_CONFIG\""
  fi
  if command -v node >/dev/null 2>&1 && ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$MODEL_CONFIG" >/dev/null 2>&1; then
    fail "model config is not valid JSON: $MODEL_CONFIG"
  fi
  if [ -n "$CORE_ENV_FILE" ] && [ ! -f "$CORE_ENV_FILE" ]; then
    fail "core env file not found: $CORE_ENV_FILE"
  fi
}

container_exists() {
  docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1
}

container_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || true)" = "true" ]
}

container_image_name() {
  docker inspect -f '{{.Config.Image}}' "$CONTAINER_NAME" 2>/dev/null || true
}

container_uses_target_image() {
  [ "$(container_image_name)" = "$IMAGE_NAME" ]
}

container_image_is_stale() {
  local target_id current_id
  target_id="$(docker image inspect "$IMAGE_NAME" --format '{{.Id}}' 2>/dev/null || true)"
  current_id="$(docker inspect -f '{{.Image}}' "$CONTAINER_NAME" 2>/dev/null || true)"
  [ -n "$target_id" ] && [ -n "$current_id" ] && [ "$target_id" != "$current_id" ]
}

container_spec_hash() {
  docker inspect -f "{{ index .Config.Labels \"$SPEC_LABEL\" }}" "$CONTAINER_NAME" 2>/dev/null || true
}

container_filter() {
  printf 'name=^%s$\n' "$CONTAINER_NAME"
}

run_container() {
  local args=(
    -d
    --name "$CONTAINER_NAME"
    --restart unless-stopped
    --label "$SPEC_LABEL=$SPEC_HASH"
    --log-opt max-size=10m
    --log-opt max-file=3
    -p "$CORE_PORT:4310"
    -v "$WORKSPACE_DIR:/app/workspace"
    -v "$MODEL_CONFIG:/app/config/model-provider.json:ro"
  )
  if [ -n "$CORE_ENV_FILE" ]; then
    args+=(--env-file "$CORE_ENV_FILE")
  fi
  docker run "${args[@]}" "$IMAGE_NAME"
}

wait_health() {
  ensure_curl
  local url
  url="$(health_url)"
  for _ in $(seq 1 30); do
    if curl --max-time 2 -fsS "$url" >/dev/null 2>&1; then
      log "health ok: $url"
      return 0
    fi
    sleep 1
  done
  docker logs --tail 120 "$CONTAINER_NAME" || true
  fail "health check timed out: $url"
}

recreate_existing() {
  docker rm -f "$CONTAINER_NAME" >/dev/null
  log "creating container from $IMAGE_NAME: $CONTAINER_NAME"
  run_container >/dev/null
}

start_container() {
  ensure_docker
  ensure_image
  ensure_runtime_files

  if container_exists; then
    if ! container_uses_target_image; then
      log "existing container uses $(container_image_name), recreating with $IMAGE_NAME"
      recreate_existing
    elif container_image_is_stale; then
      log "image $IMAGE_NAME was updated since the container was created, recreating"
      recreate_existing
    elif [ "$(container_spec_hash)" != "$SPEC_HASH" ]; then
      log "container settings differ from current configuration, recreating"
      recreate_existing
    elif container_running; then
      log "$CONTAINER_NAME is already running"
    else
      log "starting existing container: $CONTAINER_NAME"
      docker start "$CONTAINER_NAME" >/dev/null
    fi
  else
    log "creating container from $IMAGE_NAME: $CONTAINER_NAME"
    run_container >/dev/null
  fi

  docker ps --filter "$(container_filter)" --format 'table {{.ID}}\t{{.Image}}\t{{.Names}}\t{{.Status}}\t{{.Ports}}'
  wait_health
}

recreate_container() {
  ensure_docker
  ensure_image
  ensure_runtime_files
  if container_exists; then
    log "removing existing container: $CONTAINER_NAME"
    docker rm -f "$CONTAINER_NAME" >/dev/null
  fi
  log "creating container from $IMAGE_NAME: $CONTAINER_NAME"
  run_container >/dev/null
  docker ps --filter "$(container_filter)" --format 'table {{.ID}}\t{{.Image}}\t{{.Names}}\t{{.Status}}\t{{.Ports}}'
  wait_health
}

update_container() {
  ensure_docker
  pull_image
  recreate_container
}

stop_container() {
  ensure_docker
  if container_exists; then
    docker stop "$CONTAINER_NAME" >/dev/null
    log "stopped: $CONTAINER_NAME"
  else
    log "container does not exist: $CONTAINER_NAME"
  fi
}

status_container() {
  ensure_docker
  docker ps -a --filter "$(container_filter)" --format 'table {{.ID}}\t{{.Image}}\t{{.Names}}\t{{.Status}}\t{{.Ports}}'
}

usage() {
  cat <<USAGE
Usage: scripts/core-docker.sh <command>

Commands:
  start       Start the container, recreating it when the image or settings changed
  recreate    Remove and recreate the container with the local/current image
  update      Pull the image, then recreate the container
  stop        Stop the container
  restart     Stop then start the container
  status      Show container status
  logs        Follow container logs
  health      Check the container health endpoint

Environment:
  SVG_TRANSFORM_CORE_IMAGE          Image name, default ghcr.io/cnzhhx/svg-transform-core:latest
  SVG_TRANSFORM_CORE_CONTAINER      Container name, default svg-transform-core
  SVG_TRANSFORM_CORE_PORT           Host port, default from SVG_TRANSFORM_CORE_URL or 4310
  SVG_TRANSFORM_CORE_WORKSPACE      Host workspace dir, default ./workspace/core
  SVG_TRANSFORM_CORE_MODEL_CONFIG   Host model config, default ./backend/config/model-provider.json
  SVG_TRANSFORM_CORE_ENV_FILE       Optional env file passed to docker run
USAGE
}

CORE_PORT="$(resolve_core_port)"
WORKSPACE_DIR="$(resolve_host_path "$WORKSPACE_DIR")"
MODEL_CONFIG="$(resolve_host_path "$MODEL_CONFIG")"
if [ -n "$CORE_ENV_FILE" ]; then
  CORE_ENV_FILE="$(resolve_host_path "$CORE_ENV_FILE")"
fi
SPEC_HASH="$(spec_hash)"

command="${1:-start}"
case "$command" in
  start)
    start_container
    ;;
  recreate)
    recreate_container
    ;;
  update)
    update_container
    ;;
  stop)
    stop_container
    ;;
  restart)
    stop_container
    start_container
    ;;
  status)
    status_container
    ;;
  logs)
    ensure_docker
    docker logs -f "$CONTAINER_NAME"
    ;;
  health)
    ensure_curl
    curl --max-time 3 -fsS "$(health_url)"
    printf '\n'
    ;;
  help | --help | -h)
    usage
    ;;
  *)
    usage
    fail "unknown command: $command"
    ;;
esac
