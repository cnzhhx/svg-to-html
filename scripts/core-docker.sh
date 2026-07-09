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
  if [ -n "$PORT" ]; then
    printf '%s\n' "$PORT"
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

ensure_docker() {
  command -v docker >/dev/null 2>&1 || fail "docker command not found"
  docker info >/dev/null 2>&1 || fail "Docker daemon is not running"
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

run_container() {
  if [ -n "$CORE_ENV_FILE" ]; then
    docker run -d \
      --name "$CONTAINER_NAME" \
      -p "$CORE_PORT:4310" \
      -v "$WORKSPACE_DIR:/app/workspace" \
      -v "$MODEL_CONFIG:/app/config/model-provider.json:ro" \
      --env-file "$CORE_ENV_FILE" \
      "$IMAGE_NAME"
    return
  fi

  docker run -d \
    --name "$CONTAINER_NAME" \
    -p "$CORE_PORT:4310" \
    -v "$WORKSPACE_DIR:/app/workspace" \
    -v "$MODEL_CONFIG:/app/config/model-provider.json:ro" \
    "$IMAGE_NAME"
}

wait_health() {
  local url="http://127.0.0.1:$CORE_PORT/health"
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

start_container() {
  ensure_docker
  ensure_image
  ensure_runtime_files

  if container_exists; then
    if ! container_uses_target_image; then
      log "existing container uses $(container_image_name), recreating with $IMAGE_NAME"
      docker rm -f "$CONTAINER_NAME" >/dev/null
      log "creating container from $IMAGE_NAME: $CONTAINER_NAME"
      run_container >/dev/null
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

  docker ps --filter "name=$CONTAINER_NAME" --format 'table {{.ID}}\t{{.Image}}\t{{.Names}}\t{{.Status}}\t{{.Ports}}'
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
  docker ps --filter "name=$CONTAINER_NAME" --format 'table {{.ID}}\t{{.Image}}\t{{.Names}}\t{{.Status}}\t{{.Ports}}'
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
  docker ps -a --filter "name=$CONTAINER_NAME" --format 'table {{.ID}}\t{{.Image}}\t{{.Names}}\t{{.Status}}\t{{.Ports}}'
}

usage() {
  cat <<USAGE
Usage: scripts/core-docker.sh <command>

Commands:
  start       Start existing container or create it when missing
  recreate    Remove and recreate the container with the local/current image
  update      Pull the image, then recreate the container
  stop        Stop the container
  restart     Stop then start the container
  status      Show container status
  logs        Follow container logs
  health      Check http://127.0.0.1:\$SVG_TRANSFORM_CORE_PORT/health

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
    curl --max-time 3 -fsS "http://127.0.0.1:$CORE_PORT/health"
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
