#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OS_NAME="$(uname -s)"

NODE_VERSION="${NODE_VERSION:-22.16.0}"
PNPM_VERSION="${PNPM_VERSION:-10.11.0}"
OPENCODE_VERSION="${OPENCODE_VERSION:-1.17.7}"

SKIP_SYSTEM_DEPS="${SKIP_SYSTEM_DEPS:-0}"
SKIP_NODE_INSTALL="${SKIP_NODE_INSTALL:-0}"
SKIP_GLOBAL_TOOLS="${SKIP_GLOBAL_TOOLS:-0}"
SKIP_BROWSER_INSTALL="${SKIP_BROWSER_INSTALL:-0}"
SKIP_FONT_INSTALL="${SKIP_FONT_INSTALL:-0}"
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

detect_browser() {
  if [ -n "${CHROMIUM_PATH:-}" ] || [ -n "${CHROME_PATH:-}" ] || [ -n "${BROWSER_PATH:-}" ]; then
    return 0
  fi

  local candidate
  for candidate in chromium chromium-browser google-chrome google-chrome-stable chrome microsoft-edge microsoft-edge-stable; do
    if command -v "$candidate" >/dev/null 2>&1; then
      return 0
    fi
  done

  if is_macos; then
    for candidate in \
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
      "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
      [ -x "$candidate" ] && return 0
    done
  fi

  return 1
}

install_linux_system_deps() {
  if command -v apt-get >/dev/null 2>&1; then
    install_linux_apt_deps
    return
  fi

  if command -v dnf >/dev/null 2>&1; then
    install_linux_rpm_deps dnf
    return
  fi

  if command -v yum >/dev/null 2>&1; then
    install_linux_rpm_deps yum
    return
  fi

  fail "Linux installer supports apt-get, dnf, or yum; install system deps manually or set SKIP_SYSTEM_DEPS=1"
}

install_linux_apt_deps() {
  log "installing Linux system packages"
  run_as_root apt-get update

  local packages=(
    ca-certificates
    curl
    fontconfig
    git
    procps
    xz-utils
  )

  if [ "$SKIP_FONT_INSTALL" != "1" ]; then
    packages+=(fonts-noto-cjk)
  fi

  if [ "$SKIP_BROWSER_INSTALL" != "1" ]; then
    if apt-cache show chromium >/dev/null 2>&1; then
      packages+=(chromium)
    elif apt-cache show chromium-browser >/dev/null 2>&1; then
      packages+=(chromium-browser)
    else
      log "no chromium package found in apt; install Chrome/Chromium manually and set CHROMIUM_PATH"
    fi
  fi

  run_as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${packages[@]}"
}

rpm_package_available() {
  local manager="$1"
  local package="$2"

  "$manager" -q "$package" >/dev/null 2>&1 || "$manager" list --available "$package" >/dev/null 2>&1
}

install_linux_rpm_deps() {
  local manager="$1"
  local packages=(
    ca-certificates
    curl
    fontconfig
    git
    gzip
    procps-ng
    tar
    xz
  )

  log "installing Linux system packages with $manager"

  if [ "$SKIP_FONT_INSTALL" != "1" ]; then
    local font_package=""
    for candidate in google-noto-sans-cjk-fonts google-noto-cjk-fonts google-noto-sans-cjk-ttc-fonts; do
      if rpm_package_available "$manager" "$candidate"; then
        font_package="$candidate"
        break
      fi
    done

    if [ -n "$font_package" ]; then
      packages+=("$font_package")
    else
      log "no Noto CJK font package found in $manager repos; install CJK fonts manually if needed"
    fi
  fi

  if [ "$SKIP_BROWSER_INSTALL" != "1" ]; then
    local browser_package=""
    for candidate in chromium google-chrome-stable; do
      if rpm_package_available "$manager" "$candidate"; then
        browser_package="$candidate"
        break
      fi
    done

    if [ -n "$browser_package" ]; then
      packages+=("$browser_package")
    else
      log "no Chrome/Chromium package found in $manager repos; install Chrome/Chromium manually and set CHROMIUM_PATH"
    fi
  fi

  run_as_root "$manager" install -y "${packages[@]}"
}

brew_install_if_missing() {
  local formula="$1"
  local command_name="$2"

  if command -v "$command_name" >/dev/null 2>&1; then
    return
  fi

  command -v brew >/dev/null 2>&1 || fail "Homebrew is required to install $formula on macOS"
  log "installing $formula"
  brew install "$formula"
}

brew_install_cask_if_missing() {
  local cask="$1"

  command -v brew >/dev/null 2>&1 || fail "Homebrew is required to install $cask on macOS"
  if brew list --cask "$cask" >/dev/null 2>&1; then
    return
  fi

  log "installing $cask"
  brew install --cask "$cask"
}

install_macos_system_deps() {
  command -v curl >/dev/null 2>&1 || fail "curl is required"

  if command -v git >/dev/null 2>&1; then
    :
  elif command -v brew >/dev/null 2>&1; then
    brew install git
  else
    fail "git is required; install Xcode Command Line Tools or Homebrew git"
  fi

  if [ "$SKIP_BROWSER_INSTALL" != "1" ] && ! detect_browser; then
    brew_install_cask_if_missing "google-chrome"
  fi

  if [ "$SKIP_FONT_INSTALL" != "1" ]; then
    if command -v brew >/dev/null 2>&1; then
      brew_install_cask_if_missing "font-noto-sans-cjk-sc"
    else
      log "Homebrew not found; skip optional Noto CJK font installation"
    fi
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

install_global_tools() {
  if [ "$SKIP_GLOBAL_TOOLS" = "1" ]; then
    log "skip global pnpm/opencode installation"
    return
  fi

  log "installing pnpm ${PNPM_VERSION} and opencode-ai ${OPENCODE_VERSION}"
  if npm install -g "pnpm@${PNPM_VERSION}" "opencode-ai@${OPENCODE_VERSION}"; then
    :
  else
    run_as_root env PATH="$PATH" npm install -g "pnpm@${PNPM_VERSION}" "opencode-ai@${OPENCODE_VERSION}"
  fi

  command -v pnpm >/dev/null 2>&1 || fail "pnpm was not installed"
  command -v opencode >/dev/null 2>&1 || fail "opencode was not installed"

  log "pnpm $(pnpm --version)"
  log "opencode $(opencode --version)"
}

install_project_deps() {
  cd "$ROOT_DIR"

  log "creating workspace directory"
  mkdir -p workspace

  log "installing project dependencies"
  pnpm install --no-frozen-lockfile

  log "building browser MCP server"
  pnpm run build:mcp

  if [ "$RUN_TYPECHECK" = "1" ]; then
    log "running TypeScript type check"
    pnpm exec tsc --noEmit
  fi
}

main() {
  require_supported_os
  cd "$ROOT_DIR"

  install_system_deps
  install_node
  install_global_tools
  install_project_deps

  log "done"
  log "start with: scripts/start-linux.sh start"
}

main "$@"
