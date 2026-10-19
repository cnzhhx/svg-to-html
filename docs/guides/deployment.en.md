# Deployment and maintenance

[Home](../../README.en.md) · [简体中文](deployment.md) · [Configuration](configuration.en.md) · [Administration](administration.en.md)

## Services

The application lives under `/transformer/`. During development Vite proxies API requests. In production Nginx forwards requests to the gateway, which also serves the built frontend. The gateway connects to the independent Core service; Core calls the configured model provider and stores task artifacts.

| Service | Default address or port | Purpose |
| --- | --- | --- |
| Development frontend | `http://localhost:5173/transformer/` | Local development UI |
| API gateway | `127.0.0.1:8081` | Static frontend, task access, administration, and operating policy |
| Conversion Core | `127.0.0.1:4310` | Conversion execution, artifacts, and execution concurrency |
| Nginx | `80`; operators configure HTTPS | Public entry and reverse proxy |

The gateway binds to loopback. Core helper scripts publish the container port on loopback too. Core execution APIs should be accessible only by trusted gateways.

## Initial Ubuntu installation

Use an Ubuntu host with systemd and sudo access. Clone as the ordinary user that will run the application, in a directory accessible to that user:

```bash
git clone https://github.com/cnzhhx/svg-to-html.git
cd svg-to-html
sudo bash scripts/deploy-ubuntu.sh
```

The installer installs system dependencies, prepares external configuration and data directories, installs application dependencies, runs tests, builds and checks types, starts Core, configures the `svg-to-html` systemd service and Nginx, and checks health.

It writes the corresponding systemd and Nginx configuration. It only replaces an unmodified distribution-provided Nginx default site and refuses to replace a customized default site. Review and back up existing server configuration first. Use this script for initial provisioning and [application releases](#application-releases) for subsequent code updates.

| File or directory | Default location |
| --- | --- |
| Application environment | `/etc/svg-to-html/app.env` |
| Model configuration | `/etc/svg-to-html/model-provider.json` |
| Gateway runtime data | `workspace/gateway/` under the project |
| Core workspace | `workspace/core/` under the project |
| systemd service | `svg-to-html` |
| Nginx site configuration | `/etc/nginx/sites-available/svg-to-html` |

Missing configuration is created from templates. Placeholder credentials and model values cannot perform real conversions. Fill in the model file using the [configuration guide](configuration.en.md). If Core is already running, reload its model configuration with no active tasks. The default entry is `http://YOUR_SERVER/transformer/`.

Initial installation accepts `ENV_FILE`, `SVG_TO_HTML_SERVICE_USER`, and `SVG_TO_HTML_SERVICE_NAME`. The application release script targets the default `svg-to-html` service and Core on localhost port `4310`; verify compatibility yourself if you customize this layout.

## Administrator setup

Management commands must use the same environment and runtime path as the gateway. In the default installation, only root can read `/etc/svg-to-html/app.env`, while the service user should write runtime data. From the project root, use an authorized shell to load the environment, then switch to the user configured in systemd:

```bash
sudo bash -c '
set -euo pipefail
set -a
. /etc/svg-to-html/app.env
set +a
export ENV_FILE=/dev/null
service_user="$(systemctl show svg-to-html -p User --value)"
test -n "$service_user"
exec runuser -u "$service_user" -- pnpm admin:setup-token
'
```

`ENV_FILE=/dev/null` makes the command use the loaded environment without reopening the protected file. This preserves configuration permissions and lets the service user write management data. Adjust the environment path and service name for a custom installation.

Visit `/transformer/setup` to create an account. For password recovery, use the same block and replace its final `pnpm admin:setup-token` with `pnpm admin:reset-password`.

If your execution identity already has permission to read the environment and write runtime data, you can also run:

```bash
ENV_FILE=/etc/svg-to-html/app.env pnpm admin:setup-token
```

Keep credentials private and avoid creating root-owned runtime files that the service cannot update. Setup and recovery tokens are for server operators only; do not post them in Issues or public logs.

## Reverse proxy

Preserve the `/transformer/` prefix. This snippet matches the installer's main proxy settings and can be used in an existing Nginx site. Match `8081` to the gateway's `PORT`:

```nginx
location /transformer/ {
    # Allow multipart overhead; the gateway enforces the SVG file size separately.
    client_max_body_size 51m;
    proxy_pass http://127.0.0.1:8081;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

Task updates use event streams; disabling proxy buffering lets them arrive promptly. Preserve the public Host and protocol for same-origin validation. Configure your domain, HTTPS, and ingress rate limits separately; the installer provides HTTP by default.

## Application releases

Publishing from a development machine to an existing installation requires SSH key authentication, passwordless sudo on the server, and local `ssh` and `rsync`. The server must already have Node.js and pnpm. Supply your own deployment values:

```bash
TOC_DEPLOY_HOST=ubuntu@your-server \
TOC_DEPLOY_DIR=/home/ubuntu/svg-to-html \
TOC_DEPLOY_URL=https://your-domain/transformer \
pnpm publish:app
```

Use the application root URL without a trailing slash for `TOC_DEPLOY_URL`. Source code has no personal deployment targets or credentials. `pnpm publish:toc` remains a compatibility alias.

The snapshot includes uncommitted source changes, new files, and deletions from the current working directory, so review your Git diff before publishing. Environment files, model credentials, runtime data, and local planning documents are excluded. Guides under `docs/` are distributed through Git and are not uploaded as website runtime files.

The script validates, installs, tests, and builds in remote staging before checking active jobs. Unfinished jobs block activation. Wait for them to finish and retry; do not terminate work to bypass the guard.

Before activation it backs up existing code and dependencies and retains private configuration. After switching it restarts the gateway and verifies health, model options, and public assets. Activation failures restore previous code and dependencies. The output reports the backup location, under `svg-to-html-backups/` beside the project by default. This does not replace runtime data backups.

Application releases preserve Core images, models, and task data. Evaluate Core upgrades separately and perform them in a maintenance window after active tasks finish. `service-ubuntu.sh restart/update` involves Core and is not an alternative for frontend-and-gateway-only releases.

## Upgrading to Core v0.2.2

Updating application code leaves existing environment files and running Core instances intact. To upgrade Core separately, wait for active jobs to finish, back up the runtime data below, change `SVG_TRANSFORM_CORE_IMAGE` in the matching environment file to `ghcr.io/cnzhhx/svg-transform-core:0.2.2`, then run `pnpm core:update` with the same `ENV_FILE`.

The new image runs as uid/gid `1000:1000`. On Linux, the Core workspace must be writable by uid `1000`; the model file must be readable by that user or its owning group. The helper adds the model file's group to the container and checks mount permissions in a disposable container before replacing Core. Failed checks preserve the existing container and permissions. First-time installation sets ownership only for a new workspace; operators must review permission changes to existing data.

Containers have a 35-second stop timeout to allow Core's 30-second shutdown flush. After upgrading, check `http://127.0.0.1:4310/ready` as well as `/health` to verify the workspace, browser, agent executable, and model configuration. Readiness makes no model request and does not verify provider connectivity.

The default download in v0.2.2 is the final deliverable ZIP with a checksum manifest and run instructions. The interface also offers diagnostic downloads for analysis and execution history. Historical jobs without a deliverable use diagnostic downloads. Browser preview caches support offline viewing; online downloads always obtain the complete package from Core.

## Backups and migration

| Content | Why it must be retained |
| --- | --- |
| `access-state.json` | Task ownership, hashed cookie identities, and daily usage |
| Adjacent `gateway-state.json` | Operating policy, showcase overrides, and hashed administrator credentials and setup tokens |
| Complete Core workspace | Historical tasks, generated files, and execution concurrency in `queue-settings.json` |
| Environment and model files | Service connections, data paths, and model access |

Gateway settings always live beside `SVG_TO_HTML_ACCESS_STATE_PATH`. Back up and restore both gateway JSON files together. Backups also contain sensitive information and require restricted access.

Before migration, let tasks finish and suspend writes from related services and management commands before taking a consistent backup. Restore the same environment, verify data paths, ownership, and service write access, then start services. Code backups or a fresh clone do not replace runtime data backups.

Existing cookies and the ownership ledger format remain compatible. Historical Core tasks without registered ownership remain administrator-only when isolation is enabled, unless showcased. Legacy IP ownership records can still bind once to a browser cookie.

Corrupt runtime files fail explicitly rather than resetting automatically. `gateway-state.json.lock` is a short-lived write lock. Handle a stale lock after a crash only after confirming that the gateway and all management commands have stopped; do not remove it while they are running.

## Preview and access security

Online HTML / SVG and browser-cached previews allow inline, same-origin, and Blob scripts for live-preview fitting and bundled Vue / React rendering. CSP still blocks direct network connections, form submissions, workers, and plugins, and does not allow external scripts. Downloaded files are unchanged.

Previews retain the application's origin. This policy does not isolate them from administrator privileges, and generated scripts must be treated as trusted code. Evaluate this boundary for your use case before hosting untrusted content publicly.

Job write endpoints require `X-Requested-With: svg-to-html`; browser-supplied `Origin` must match the gateway origin. These checks do not prevent same-origin preview scripts from using the current user's privileges. See [access isolation](administration.en.md#access-isolation) for visibility when isolation is disabled.

## Status and troubleshooting

### Check services

These commands inspect status and logs without recreating Core:

```bash
sudo systemctl status svg-to-html --no-pager
sudo journalctl -u svg-to-html -n 100 --no-pager
curl --fail http://127.0.0.1:8081/transformer/health
curl --fail http://127.0.0.1:4310/health
```

For local development, `pnpm doctor`, `pnpm core:status`, and `pnpm core:health` inspect dependencies, model files, and Core health. `pnpm doctor` reads the root `.env` by default; align the checking environment with any external deployment configuration.

| Symptom | Check first |
| --- | --- |
| Healthy gateway but failed conversions | Core health, `SVG_TRANSFORM_CORE_URL`, and model configuration; gateway liveness does not imply Core readiness |
| Empty or placeholder model list | The gateway's model file path, JSON syntax, and placeholder values |
| Upload too large | The administrator SVG size limit and reverse proxy body limit |
| Progress stops updating | Event-stream buffering, proxy timeouts, and network connectivity |
| Administrator writes rejected | Login, public Host / protocol, same-origin headers, and revision conflicts |
| Settings seem missing after a management command | Whether `ENV_FILE`, ledger path, and execution identity match the service |
| Tasks disappear after switching browsers | Anonymous ownership depends on the original browser cookie, without account synchronization |
| Runtime data cannot be written | Directory permissions, disk space, and ownership; do not delete ledgers to resolve it |

Setup, login, and settings remain available when Core is down. Conversion endpoints report Core unavailability.
