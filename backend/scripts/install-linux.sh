#!/usr/bin/env bash
set -euo pipefail

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "$BACKEND_DIR/.." && pwd)"
OS_NAME="$(uname -s)"

NODE_VERSION="${NODE_VERSION:-22.16.0}"
PNPM_VERSION="${PNPM_VERSION:-10.11.0}"

SKIP_SYSTEM_DEPS="${SKIP_SYSTEM_DEPS:-0}"
SKIP_NODE_INSTALL="${SKIP_NODE_INSTALL:-0}"
SKIP_GLOBAL_TOOLS="${SKIP_GLOBAL_TOOLS:-0}"
RUN_TYPECHECK="${RUN_TYPECHECK:-0}"

log() {
  printf '[install] %s\n' "$*"
}

fail() {
  printf '[install] ERROR: %s\n' "$*" >&2
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

run_as_root() {
  if [ "${EUID}" -eq 0 ]; then
    "$@"
    return
  fi

  command -v sudo >/dev/null 2>&1 || fail "sudo is required when not running as root"
  sudo "$@"
}

version_satisfies_node() {
  local raw="${1#v}"
  local major minor patch

  IFS='.' read -r major minor patch <<<"$raw"
  major="${major:-0}"
  minor="${minor:-0}"

  case "$major:$minor" in
    20:*)
      [ "$minor" -ge 19 ]
      ;;
    21:*)
      return 1
      ;;
    22:*)
      [ "$minor" -ge 12 ]
      ;;
    *)
      [ "$major" -gt 22 ]
      ;;
  esac
}

current_node_satisfies() {
  command -v node >/dev/null 2>&1 && version_satisfies_node "$(node --version)"
}

node_arch() {
  local arch

  if is_linux && command -v dpkg >/dev/null 2>&1; then
    arch="$(dpkg --print-architecture)"
  else
    arch="$(uname -m)"
  fi

  case "$arch" in
    amd64 | x86_64)
      printf 'x64'
      ;;
    arm64 | aarch64)
      printf 'arm64'
      ;;
    armhf | armv7l)
      is_linux || fail "unsupported CPU architecture on macOS: $arch"
      printf 'armv7l'
      ;;
    ppc64el | ppc64le)
      is_linux || fail "unsupported CPU architecture on macOS: $arch"
      printf 'ppc64le'
      ;;
    s390x)
      is_linux || fail "unsupported CPU architecture on macOS: $arch"
      printf 's390x'
      ;;
    *)
      fail "unsupported CPU architecture: $arch"
      ;;
  esac
}

install_linux_system_deps() {
  if command -v apt-get >/dev/null 2>&1; then
    log "installing Linux system packages with apt-get"
    run_as_root apt-get update
    run_as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      procps \
      xz-utils
    return
  fi

  local manager=""
  if command -v dnf >/dev/null 2>&1; then
    manager="dnf"
  elif command -v yum >/dev/null 2>&1; then
    manager="yum"
  fi

  if [ -n "$manager" ]; then
    log "installing Linux system packages with $manager"
    run_as_root "$manager" install -y ca-certificates curl git gzip procps-ng tar xz
    return
  fi

  fail "Linux installer supports apt-get, dnf, or yum; install system deps manually or set SKIP_SYSTEM_DEPS=1"
}

install_macos_system_deps() {
  command -v curl >/dev/null 2>&1 || fail "curl is required"

  if ! command -v git >/dev/null 2>&1; then
    command -v brew >/dev/null 2>&1 || fail "git is required; install Xcode Command Line Tools or Homebrew git"
    log "installing git"
    brew install git
  fi
}

install_system_deps() {
  if [ "$SKIP_SYSTEM_DEPS" = "1" ]; then
    log "skip system dependency installation"
    return
  fi

  if is_linux; then
    install_linux_system_deps
  else
    install_macos_system_deps
  fi
}

install_node() {
  if current_node_satisfies; then
    log "node $(node --version) already satisfies package.json engines"
    return
  fi

  if [ "$SKIP_NODE_INSTALL" = "1" ]; then
    fail "node is missing or too old; install Node ${NODE_VERSION} or unset SKIP_NODE_INSTALL"
  fi

  command -v curl >/dev/null 2>&1 || fail "curl is required to install Node"

  local arch platform extension archive url tar_flags
  arch="$(node_arch)"
  platform="$(is_macos && printf 'darwin' || printf 'linux')"

  if is_macos; then
    extension="tar.gz"
    tar_flags="-xzf"
  else
    extension="tar.xz"
    tar_flags="-xJf"
  fi

  archive="/tmp/node-v${NODE_VERSION}-${platform}-${arch}.${extension}"
  url="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${platform}-${arch}.${extension}"

  log "installing Node ${NODE_VERSION} (${platform}-${arch}) to /usr/local"
  curl -fsSL "$url" -o "$archive"
  run_as_root mkdir -p /usr/local
  run_as_root tar "$tar_flags" "$archive" -C /usr/local --strip-components=1
  rm -f "$archive"
  hash -r 2>/dev/null || true

  current_node_satisfies || fail "installed node $(node --version 2>/dev/null || printf 'unknown') does not satisfy package.json engines"
  log "node $(node --version)"
  log "npm $(npm --version)"
}

run_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    pnpm "$@"
    return
  fi

  command -v corepack >/dev/null 2>&1 || fail "pnpm is not installed and corepack is not available"
  corepack pnpm "$@"
}

install_package_manager() {
  if command -v pnpm >/dev/null 2>&1; then
    log "pnpm $(pnpm --version)"
    return
  fi

  command -v corepack >/dev/null 2>&1 || fail "corepack is required to activate pnpm"

  if [ "$SKIP_GLOBAL_TOOLS" = "1" ]; then
    log "skip pnpm activation; will use corepack pnpm if already available"
    corepack pnpm --version >/dev/null 2>&1 || fail "corepack pnpm is not available"
    return
  fi

  log "activating pnpm ${PNPM_VERSION} with corepack"
  corepack enable >/dev/null 2>&1 || true
  corepack prepare "pnpm@${PNPM_VERSION}" --activate
  log "pnpm $(corepack pnpm --version)"
}

install_project_deps() {
  cd "$ROOT_DIR"

  log "installing project dependencies"
  run_pnpm install --no-frozen-lockfile

  log "building frontend static assets"
  run_pnpm -C "$ROOT_DIR/frontend" build

  if [ "$RUN_TYPECHECK" = "1" ]; then
    log "running TypeScript type check"
    run_pnpm -C "$BACKEND_DIR" exec tsc --noEmit
  fi

  log "checking gateway prerequisites"
  run_pnpm -C "$BACKEND_DIR" run doctor
}

main() {
  require_supported_os
  cd "$ROOT_DIR"

  install_system_deps
  install_node
  install_package_manager
  install_project_deps

  log "done"
  log "start with: backend/scripts/start-linux.sh start"
}

main "$@"
