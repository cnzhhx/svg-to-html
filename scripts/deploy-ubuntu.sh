#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-/etc/svg-to-html/app.env}"
SERVICE_NAME="${SVG_TO_HTML_SERVICE_NAME:-svg-to-html}"
NGINX_SITE="${SVG_TO_HTML_NGINX_SITE:-svg-to-html}"
SERVICE_USER="${SVG_TO_HTML_SERVICE_USER:-${SUDO_USER:-$(id -un)}}"
CONFIG_GROUP="${SVG_TO_HTML_CONFIG_GROUP:-svg-to-html}"

log() {
  printf '[deploy-ubuntu] %s\n' "$*"
}

warn() {
  printf '[deploy-ubuntu] WARN: %s\n' "$*" >&2
}

fail() {
  printf '[deploy-ubuntu] ERROR: %s\n' "$*" >&2
  exit 1
}

require_root() {
  [ "$(id -u)" -eq 0 ] || fail "run with sudo: sudo bash scripts/deploy-ubuntu.sh"
}

require_ubuntu() {
  [ -r /etc/os-release ] || fail "cannot identify the operating system"
  # shellcheck disable=SC1091
  . /etc/os-release
  [ "${ID:-}" = "ubuntu" ] || fail "this installer supports Ubuntu only"
}

install_packages() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ca-certificates curl git nginx docker.io
  systemctl enable --now docker nginx

  local node_major=0
  if command -v node >/dev/null 2>&1; then
    node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  fi
  if [ "$node_major" -lt 20 ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi

  if ! command -v pnpm >/dev/null 2>&1 || [ "$(pnpm --version)" != "10.11.0" ]; then
    npm install --global pnpm@10.11.0
  fi

  id "$SERVICE_USER" >/dev/null 2>&1 || fail "service user does not exist: $SERVICE_USER"
}

validate_nginx_default_site() {
  local enabled_default="/etc/nginx/sites-enabled/default"
  [ -e "$enabled_default" ] || [ -L "$enabled_default" ] || return 0
  [ -L "$enabled_default" ] \
    || fail "refusing to replace regular Nginx default site: $enabled_default"

  local default_target expected_hash actual_hash
  default_target="$(readlink -f "$enabled_default" || true)"
  [ "$default_target" = "/etc/nginx/sites-available/default" ] \
    || fail "refusing to replace custom Nginx default site: $enabled_default"
  expected_hash="$(
    dpkg-query -W -f='${Conffiles}\n' nginx nginx-common 2>/dev/null \
      | awk '$1 == "/etc/nginx/sites-available/default" { print $2; exit }' \
      || true
  )"
  actual_hash="$(md5sum "$default_target" | awk '{ print $1 }')"
  [ -n "$expected_hash" ] && [ "$actual_hash" = "$expected_hash" ] \
    || fail "refusing to replace modified Nginx default site: $default_target"
}

resolve_host_path() {
  local value="$1"
  case "$value" in
    /*) printf '%s\n' "$value" ;;
    *) printf '%s\n' "$ROOT_DIR/${value#./}" ;;
  esac
}

load_config() {
  local config_dir
  config_dir="$(dirname "$ENV_FILE")"

  getent group "$CONFIG_GROUP" >/dev/null || groupadd --system "$CONFIG_GROUP"
  if [ ! -d "$config_dir" ]; then
    install -d -m 750 -o root -g "$CONFIG_GROUP" "$config_dir"
  elif [ "$config_dir" = "/etc/svg-to-html" ]; then
    chown "root:$CONFIG_GROUP" "$config_dir"
    chmod 750 "$config_dir"
  fi
  if [ ! -f "$ENV_FILE" ]; then
    install -m 600 -o root -g root "$ROOT_DIR/.env.example" "$ENV_FILE"
    log "created deployment config from .env.example: $ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a

  PORT="${PORT:-8081}"
  [[ "$PORT" =~ ^[0-9]+$ ]] || fail "PORT must be numeric"
  [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || fail "PORT must be between 1024 and 65535"

  MODEL_CONFIG="$(resolve_host_path "${SVG_TRANSFORM_CORE_MODEL_CONFIG:-$(dirname "$ENV_FILE")/model-provider.json}")"
  if [ ! -f "$MODEL_CONFIG" ]; then
    if [ ! -d "$(dirname "$MODEL_CONFIG")" ]; then
      install -d -m 750 -o root -g "$CONFIG_GROUP" "$(dirname "$MODEL_CONFIG")"
    fi
    install -m 640 -o root -g "$CONFIG_GROUP" \
      "$ROOT_DIR/backend/config/model-provider.example.json" "$MODEL_CONFIG"
    log "created external model config from example: $MODEL_CONFIG"
  fi
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$MODEL_CONFIG" >/dev/null \
    || fail "model config is not valid JSON: $MODEL_CONFIG"
  chown "root:$CONFIG_GROUP" "$MODEL_CONFIG"
  chmod 640 "$MODEL_CONFIG"
  if [[ "$MODEL_CONFIG" == /etc/svg-to-html/* ]]; then
    chown "root:$CONFIG_GROUP" /etc/svg-to-html
    chmod 750 /etc/svg-to-html
  fi
  runuser -u "$SERVICE_USER" -g "$CONFIG_GROUP" -- test -r "$MODEL_CONFIG" \
    || fail "service user $SERVICE_USER cannot read model config: $MODEL_CONFIG"
  if grep -q '"your-model"\|"api.example.com"\|"your-api-key"\|"YOUR_PROVIDER_API_KEY"' "$MODEL_CONFIG"; then
    warn "model config still contains placeholders: $MODEL_CONFIG"
    warn "Deployment will start, but real conversions require a valid model provider."
  fi
  export SVG_TRANSFORM_CORE_MODEL_CONFIG="$MODEL_CONFIG"
}

prepare_access_state() {
  local default_state_path="$ROOT_DIR/workspace/gateway/access-state.json"
  ACCESS_STATE_PATH="$(resolve_host_path "${SVG_TO_HTML_ACCESS_STATE_PATH:-$default_state_path}")"
  local access_state_dir
  access_state_dir="$(dirname "$ACCESS_STATE_PATH")"

  if [ ! -d "$access_state_dir" ]; then
    install -d -m 750 -o "$SERVICE_USER" -g "$CONFIG_GROUP" "$access_state_dir"
  elif [ "$access_state_dir" = "$(dirname "$default_state_path")" ]; then
    chown "$SERVICE_USER:$CONFIG_GROUP" "$access_state_dir"
    chmod 750 "$access_state_dir"
  fi
  if [ -f "$ACCESS_STATE_PATH" ]; then
    chown "$SERVICE_USER:$CONFIG_GROUP" "$ACCESS_STATE_PATH"
    chmod 600 "$ACCESS_STATE_PATH"
  fi
  runuser -u "$SERVICE_USER" -g "$CONFIG_GROUP" -- test -w "$access_state_dir" \
    || fail "service user $SERVICE_USER cannot write access state directory: $access_state_dir"
  export SVG_TO_HTML_ACCESS_STATE_PATH="$ACCESS_STATE_PATH"
}

build_project() {
  cd "$ROOT_DIR"
  pnpm install --frozen-lockfile
  pnpm test
  pnpm build
  pnpm lint:frontend
}

start_core() {
  ENV_FILE="$ENV_FILE" bash "$ROOT_DIR/scripts/core-docker.sh" start
}

install_gateway_service() {
  local pnpm_bin
  pnpm_bin="$(command -v pnpm)"
  cat >"/etc/systemd/system/$SERVICE_NAME.service" <<UNIT
[Unit]
Description=SVG to HTML gateway
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
User=$SERVICE_USER
SupplementaryGroups=$CONFIG_GROUP
WorkingDirectory=$ROOT_DIR/backend
EnvironmentFile=$ENV_FILE
Environment="SVG_TRANSFORM_CORE_MODEL_CONFIG=$MODEL_CONFIG"
Environment="SVG_TO_HTML_ACCESS_STATE_PATH=$ACCESS_STATE_PATH"
ExecStart=$pnpm_bin start
Restart=on-failure
RestartSec=3
TimeoutStopSec=20
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  systemctl restart "$SERVICE_NAME"
}

install_nginx_site() {
  cat >"/etc/nginx/sites-available/$NGINX_SITE" <<NGINX
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    # Multipart adds a small envelope; the gateway enforces a strict 50 MB SVG limit.
    client_max_body_size 51m;

    # SVG files are text, so compress them when a client needs the original asset.
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_min_length 1024;
    gzip_comp_level 4;
    gzip_types image/svg+xml application/json application/javascript text/css;

    location = / {
        return 302 /transformer/;
    }

    location /transformer/ {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
NGINX

  if [ -L /etc/nginx/sites-enabled/default ]; then
    validate_nginx_default_site
    rm /etc/nginx/sites-enabled/default
  fi
  ln -sfn "/etc/nginx/sites-available/$NGINX_SITE" "/etc/nginx/sites-enabled/$NGINX_SITE"
  nginx -t
  systemctl reload nginx
}

wait_health() {
  local url="http://127.0.0.1:$PORT/transformer/health"
  for _ in $(seq 1 30); do
    if curl --max-time 2 -fsS "$url" 2>/dev/null | grep -qx 'ok'; then
      curl --max-time 2 -fsS http://127.0.0.1/transformer/health | grep -qx 'ok' \
        || fail "Nginx gateway health check failed"
      log "deployment healthy: http://SERVER_IP/transformer/"
      return
    fi
    sleep 1
  done
  journalctl -u "$SERVICE_NAME" -n 100 --no-pager || true
  fail "gateway health check timed out: $url"
}

main() {
  require_root
  require_ubuntu
  install_packages
  validate_nginx_default_site
  load_config
  prepare_access_state
  build_project
  start_core
  install_gateway_service
  install_nginx_site
  wait_health
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
