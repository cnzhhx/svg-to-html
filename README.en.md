# SVG to HTML

[简体中文](README.md) | English

One frontend and API gateway for both self-hosting and hosted trials. Conversion is provided by the independent [svg-transform-core](https://github.com/cnzhhx/svg-transform-core) Docker service. Output formats include HTML, Vue, and React.

![SVG and HTML comparison](example/comparison-4.33.png)

The example has a 4.33% visual difference; this is a sample result, not a universal guarantee.

## Start locally

Requires Node.js 20+, pnpm 10.11+, and Docker.

```bash
pnpm dev
```

Open `http://localhost:5173/transformer/`. Configure a model in `backend/config/model-provider.json` before submitting real conversions. Keep credentials server-side. Model changes require Core to reload its configuration; operating settings do not.

## Administrator setup

Run from the project root:

```bash
pnpm admin:setup-token
```

Visit `/transformer/setup`. Enter the single-use, 15-minute token, an administrator username, a password of at least 12 characters, and the initial operating settings. Visitors cannot claim the administrator account without this token.

Log in at `/transformer/login` and manage settings at `/transformer/admin/settings`. Anonymous visitors do not need accounts. Administrator sessions last up to seven days and are invalidated by a server restart, logout, or password change.

Existing ToC administrators can use the legacy-key login or the old `#adminKey=...` entry to create their account. Successful migration disables legacy-key login and old sessions.

For password recovery, run `pnpm admin:reset-password` in the same runtime environment, then select password recovery on the login page. The token expires after 15 minutes and retains the original username. A server operator can inspect the administrator record to recover the username; never expose that runtime file.

## Online settings

| Setting | Fresh-install default | Behavior |
| --- | --- | --- |
| Access isolation | Enabled | Browser-cookie ownership; showcases remain public |
| Daily upload quota | Enabled, 5/day | Per browser; administrators are exempt and not counted |
| Quota time zone | Asia/Shanghai | Changes the date boundary used for quotas |
| Maximum SVG size | 50 MB | Configurable from 1–50 MB, including administrator uploads |
| Estimated task duration | 20 minutes | Queue estimate only, not conversion concurrency |
| User showcase submissions | Enabled | Disabling does not revoke existing showcases |

Saved settings apply to subsequent requests without restarting either service. Already accepted tasks continue. Other pages refresh on focus and periodically. Concurrent administrator edits are protected by a revision check.

Disabling access isolation exposes all existing tasks for viewing, previewing, and downloading. Other visitors still cannot modify or delete them. Ownership is preserved while isolation is disabled. Re-enabling isolation revokes unauthorized active streams; previously downloaded files cannot be recalled.

Disabling the quota keeps recording usage, so re-enabling it does not reset today's count. Administrators manage showcase flags through the settings page. Ordinary users cannot delete showcases; administrators can.

Browser cookies are anonymous identities, not full user accounts or strong abuse protection. Clearing cookies creates a new identity. Configure TLS and infrastructure-level controls appropriate to public deployments.

## Persistence and migration

By default, `workspace/gateway/access-state.json` stores existing ownership and usage, and the adjacent `gateway-state.json` stores online settings, showcase overrides, and hashed administrator credentials/bootstrap tokens. Configure their directory with `SVG_TO_HTML_ACCESS_STATE_PATH`.

Back up and retain both files across upgrades. The application-only release script leaves runtime data in place. Back up existing ownership state and environment configuration before migration.

Legacy environment values for quotas, time zone, wait estimates, and showcase IDs are imported only when the settings file does not exist. Saved online settings take precedence afterwards. Corrupt files fail explicitly instead of silently resetting security policy. If a write lock remains after a crash, stop the gateway and all local management commands before removing the stale `.lock` file.

Existing ownership cookies and the access-state format remain compatible. Unregistered historical Core tasks stay administrator-only when isolation is enabled unless explicitly showcased. Legacy IP ownership can still bind once to a browser cookie.

## Deployment

The Queue and concurrency tab sets the site-wide session limit (1–32). Increasing it starts queued work immediately; decreasing it drains existing work without cancellation. It does not change per-session module concurrency. This requires Core's `GET/PUT /api/queue/settings` endpoint; older Core versions show an upgrade notice. Core persists this execution setting in workspace `queue-settings.json`, using `MAX_CONCURRENT_AGENTS` only until the first save. Preserve this runtime file in backups and exclude it from source snapshots. Queue estimates read the actual Core limit.

Keep ports, Core URL/image, model credentials, per-session module concurrency, and data paths in deployment configuration. Core execution APIs, including queue settings, must remain on a trusted private network; the gateway requires administrator authentication and same-origin validation for setting writes.

For initial Ubuntu provisioning:

```bash
sudo bash scripts/deploy-ubuntu.sh
```

The environment defaults to `/etc/svg-to-html/app.env`; the model configuration defaults to `/etc/svg-to-html/model-provider.json`. Administrator commands must use the same environment and runtime path as the gateway:

```bash
ENV_FILE=/etc/svg-to-html/app.env pnpm admin:setup-token
```

Use the service identity with permission to read that environment and write its runtime directory. Do not create root-owned runtime files that the service cannot update.

For subsequent application-only releases:

```bash
TOC_DEPLOY_HOST=ubuntu@your-server \
TOC_DEPLOY_DIR=/home/ubuntu/svg-to-html \
TOC_DEPLOY_URL=https://your-domain/transformer \
pnpm publish:app
```

`publish:toc` remains an alias. Deployment includes current uncommitted source changes, validates in staging, backs up and switches code, restarts the gateway, checks the result, and restores the previous code if activation fails. Active jobs block deployment. This script targets the existing `svg-to-html` systemd service and Core at localhost:4310. It does not replace Core, model credentials, or runtime data. Personal deployment targets have no defaults in source.

## Verification

Online HTML/SVG previews and browser-cached previews use a static sandbox: generated scripts, form submissions, and API calls are disabled. Images and styles remain available. JavaScript-dependent Vue/React output may only show static content; use the result screenshots for visual comparison and download the ZIP to run full interactions locally. Downloaded files are unchanged.

Job write endpoints require `X-Requested-With: svg-to-html`; a browser-supplied `Origin` must match the gateway origin. Reverse proxies must preserve the public Host and protocol. Do not weaken script restrictions on artifact responses.

```bash
pnpm test
pnpm build
pnpm lint:frontend
pnpm audit
pnpm doctor
```

Tests use a mock Core without model charges. They cover persistence, conflicting edits, failed writes, administrator migration/recovery, quota toggles and cross-date refunds, access permissions, stream revocation, and deployment preservation.

Path traversal and preview security regressions run with `pnpm test`. Optional browser verification requires local Chrome and Playwright: set `ARTIFACT_TEST_PLAYWRIGHT_PATH` to the absolute path of Playwright's `index.mjs` and run `pnpm test`. It uses an isolated browser context and temporary runtime directory, never a personal browser profile.

When Core is unavailable, setup, login, and settings remain accessible. Conversion requests report unavailability. The health endpoint reports gateway liveness, not Core readiness.

## License

[MIT](LICENSE). Preserve the existing copyright and license notices.
