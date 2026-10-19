# Administration

[Home](../../README.en.md) · [简体中文](administration.md) · [Configuration](configuration.en.md) · [Deployment](deployment.en.md)

## Create an administrator

Run from the repository root:

```bash
pnpm admin:setup-token
```

Visit `/transformer/setup` and enter the token, an administrator username, a password of at least 12 characters, and initial operating settings. The token is single-use and expires after 15 minutes. Visitors without the token cannot create the administrator account.

The local development URL is `http://localhost:5173/transformer/setup`. On a server, management commands must use the service's environment and runtime path; see [deployment setup](deployment.en.md#administrator-setup).

## Login and password recovery

Log in at `/transformer/login`, then visit `/transformer/admin/settings`. The workspace sidebar also provides an entry. Administrator sessions last up to seven days and are invalidated by a service restart, logout, or password change.

For a forgotten password, run from the repository root using the service's runtime environment:

```bash
pnpm admin:reset-password
```

Choose password recovery on the login page and enter the single-use recovery token and a new password within 15 minutes. The original username is retained. A server operator can inspect the administrator record in runtime data to recover the username; never share that runtime file.

## Operating settings

| Setting | Fresh-install default | Behavior |
| --- | --- | --- |
| Access isolation | Enabled | Browser-cookie ownership; showcases remain public |
| Daily quota | Enabled, 5 uploads | Per browser; administrators are exempt and not counted |
| Quota time zone | `Asia/Shanghai` | Determines date boundaries; changes apply to subsequent quota calculations |
| Maximum SVG size | 50 MB | Configurable from 1–50 MB, including administrator uploads |
| Estimated task duration | 20 minutes | Queue estimates only; does not change execution concurrency |
| User showcase submissions | Enabled | Disabling blocks new user submissions and retains existing showcases |

Saved policy applies immediately to new requests. Accepted conversions continue. Other pages refresh on focus and periodically. If concurrent edits cause a revision conflict, reload current settings, confirm your intended changes, and save again.

### Access isolation

Disabling isolation exposes all existing tasks for viewing, previewing, and downloading by every visitor. Other visitors still have read-only access; mutation and deletion permissions continue to depend on ownership, administrator status, and showcase rules.

Re-enabling isolation preserves ownership and terminates active event and download streams that lose authorization. Previously downloaded files cannot be recalled.

Cookies identify anonymous browsers, not full user accounts. Clearing cookies or switching browsers loses previous ownership and creates a new quota identity. Daily quotas do not replace ingress rate limits.

### Daily quotas

Disabling quotas keeps recording usage. Re-enabling them does not reset the current day's count. Changing the time zone changes the daily boundary; accepted tasks keep running.

### Public showcases

Administrators can set or remove showcase status for any task on the showcases page. Disabling user showcase submissions affects future submissions only. Ordinary users cannot delete showcases; administrators can.

## Queue and concurrency

The Queue and concurrency tab sets the maximum site-wide number of simultaneously executing sessions, from 1–32. Save with the button at the bottom of the page.

- Raising the limit immediately starts additional queued work.
- Lowering it lets existing tasks finish without interruption.
- Module concurrency within one session is unchanged.
- Queue wait estimates use Core's actual execution limit.

This requires Core's `GET/PUT /api/queue/settings` endpoint. Older Core versions show an upgrade notice, and failed saves are not reported as successful. Core persists the limit in workspace `queue-settings.json`. Before the first save it uses `MAX_CONCURRENT_AGENTS`; afterwards saved settings take precedence across restarts.

This is runtime data. Back it up with the complete Core workspace and exclude it from Git and code snapshots. Core execution APIs must be reachable only by trusted gateways; the gateway requires administrator login to change concurrency.

## Migrating a legacy administrator key

Existing ToC administrators can choose legacy-key migration on the login page or use the old `#adminKey=...` entry, then create an account. Successful migration disables the old key and sessions. New installations use the single-use setup token without a legacy key.

Legacy operating environment values are imported only when online settings are absent. Saved web settings take precedence afterwards. See [backups and migration](deployment.en.md#backups-and-migration) for runtime data and historical tasks.
