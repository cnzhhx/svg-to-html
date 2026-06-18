#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# SVG to HTML - One-click Deploy
# ============================================================
#
# Usage:
#   bash scripts/deploy.sh          # Install + start service
#   bash scripts/deploy.sh install  # Install only
#   bash scripts/deploy.sh start    # Start only (assumes installed)
#
# This script wraps install-linux.sh and start-linux.sh for
# quick one-command deployment on Linux and macOS.
# ============================================================

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

info()    { echo -e "${BLUE}[deploy]${NC} $*"; }
success() { echo -e "${GREEN}[deploy]${NC} $*"; }
fail()    { echo -e "${RED}[deploy] ERROR:${NC} $*" >&2; exit 1; }

do_install() {
  info "Running installation..."
  bash "$ROOT_DIR/scripts/install-linux.sh"
  success "Installation complete"
}

do_start() {
  info "Starting service..."
  bash "$ROOT_DIR/scripts/start-linux.sh" start
}

usage() {
  cat <<EOF
SVG to HTML - One-click Deploy

Usage:
  bash scripts/deploy.sh              Full deploy (install + start)
  bash scripts/deploy.sh install      Install only
  bash scripts/deploy.sh start        Start service only
  bash scripts/deploy.sh stop         Stop service
  bash scripts/deploy.sh restart      Restart service
  bash scripts/deploy.sh status       Show service status
  bash scripts/deploy.sh logs         Follow service logs

Environment variables:
  PORT=80                             HTTP listen port
  WORKSPACE=./workspace               Workspace root directory
  NODE_ENV=production                 Runtime environment
  SKIP_SYSTEM_DEPS=1                  Skip system dependency installation
  SKIP_BROWSER_INSTALL=1              Skip browser installation
EOF
}

command="${1:-deploy}"

case "$command" in
  deploy)
    echo ""
    echo "============================================================"
    echo "  SVG to HTML - One-click Deploy"
    echo "============================================================"
    echo ""
    do_install
    echo ""
    do_start
    ;;
  install)
    do_install
    ;;
  start|stop|restart|status|logs|foreground)
    bash "$ROOT_DIR/scripts/start-linux.sh" "$command"
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    fail "Unknown command: $command"
    ;;
esac
