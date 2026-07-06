#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# SVG to HTML - Local Deploy
# ============================================================
#
# Usage:
#   bash backend/scripts/deploy.sh          # Install + start service
#   bash backend/scripts/deploy.sh install  # Install only
#   bash backend/scripts/deploy.sh start    # Start only (assumes installed)
#
# Copy the project to a server first, then run this script on that server.
# ============================================================

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

info()    { printf "${BLUE}[deploy]${NC} %s\n" "$*"; }
success() { printf "${GREEN}[deploy]${NC} %s\n" "$*"; }
fail()    { printf "${RED}[deploy] ERROR:${NC} %s\n" "$*" >&2; exit 1; }

do_install() {
  info "Running installation..."
  bash "$BACKEND_DIR/scripts/install-linux.sh"
  success "Installation complete"
}

do_start() {
  info "Starting service..."
  bash "$BACKEND_DIR/scripts/start-linux.sh" start
}

usage() {
  cat <<EOF
SVG to HTML - Local Deploy

Usage:
  bash backend/scripts/deploy.sh              Full deploy (install + start)
  bash backend/scripts/deploy.sh install      Install only
  bash backend/scripts/deploy.sh start        Start service only
  bash backend/scripts/deploy.sh stop         Stop service
  bash backend/scripts/deploy.sh restart      Restart service
  bash backend/scripts/deploy.sh status       Show service status
  bash backend/scripts/deploy.sh logs         Follow service logs
  bash backend/scripts/deploy.sh foreground   Run in foreground

Environment variables:
  PORT=80                             HTTP listen port
  WORKSPACE=./workspace               Workspace root directory
  ENV_FILE=./.env                     Env file path
  SKIP_SYSTEM_DEPS=1                  Skip system dependency installation
  SKIP_BROWSER_INSTALL=1              Skip browser installation
EOF
}

command="${1:-deploy}"

case "$command" in
  deploy)
    echo ""
    echo "============================================================"
    echo "  SVG to HTML - Local Deploy"
    echo "============================================================"
    echo ""
    do_install
    echo ""
    do_start
    ;;
  install)
    do_install
    ;;
  start | stop | restart | status | logs | foreground)
    bash "$BACKEND_DIR/scripts/start-linux.sh" "$command"
    ;;
  -h | --help | help)
    usage
    ;;
  *)
    fail "Unknown command: $command"
    ;;
esac
