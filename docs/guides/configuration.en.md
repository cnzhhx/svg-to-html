# Configuration

[Home](../../README.en.md) · [简体中文](configuration.md) · [Administration](administration.en.md) · [Deployment](deployment.en.md)

Connection details belong in environment and model configuration files. Site policies belong in administrator pages. Use the web interface for routine changes to quotas, access isolation, and showcase status.

## Model configuration

The local default is `backend/config/model-provider.json`. See [model-provider.example.json](../../backend/config/model-provider.example.json) for the template. Its structure is:

```json
{
  "models": {
    "my-vision-model": {
      "runtime": "opencode",
      "provider": "openai",
      "baseURL": "https://api.example.com/v1",
      "apiKey": "your-api-key",
      "model": "your-model-id",
      "modalities": {
        "input": ["text", "image"],
        "output": ["text"]
      }
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| Each key under `models` | A model configuration ID shown in the UI; multiple IDs are supported |
| `runtime`, `provider` | Core's runtime and provider adapter; the example follows the repository template |
| `baseURL` | Your provider's API URL; replace the example address |
| `apiKey` | Provider credential, stored only on the server |
| `model` | Model name accepted by the upstream API |
| `modalities` | Input and output capabilities; conversion models need text and image input |

The application reads model IDs from this file, while Core performs conversions. An ID appearing in the UI does not confirm provider connectivity. See the [Core project](https://github.com/cnzhhx/svg-transform-core) for other supported runtimes and providers.

Ubuntu installations default to `/etc/svg-to-html/model-provider.json`. Override the path with `SVG_TRANSFORM_CORE_MODEL_CONFIG`; the gateway and Core should use the same file.

The model file is mounted read-only into Core. After editing it, run `pnpm core:recreate` when no conversions are active so Core reloads the configuration. On a server, pass the matching `ENV_FILE`. This command recreates the Core container and is separate from routine application releases.

## Environment variables

Local development reads `.env` in the repository root; see [.env.example](../../.env.example). The gateway, Core helper scripts, and administrator commands accept `ENV_FILE` for an external environment file. Defaults below refer to the supplied template.

| Variable | Template default | Purpose |
| --- | --- | --- |
| `PORT` | `8081` | Gateway port |
| `SVG_TRANSFORM_CORE_URL` | `http://127.0.0.1:4310` | Core URL used by the gateway |
| `SVG_TRANSFORM_CORE_IMAGE` | `ghcr.io/cnzhhx/svg-transform-core:0.2.1` | Pinned Core image for reproducible installation |
| `SVG_TRANSFORM_CORE_WORKSPACE` | `./workspace/core` | Persistent Core tasks and artifacts |
| `SVG_TRANSFORM_CORE_MODEL_CONFIG` | Locally, `backend/config/model-provider.json` | Model file; Ubuntu uses external configuration by default |
| `SVG_TO_HTML_ACCESS_STATE_PATH` | `./workspace/gateway/access-state.json` | Ownership and usage ledger; gateway settings live beside it |
| `MAX_CONCURRENT_AGENTS` | `1` | Initial session concurrency until Core has saved an online concurrency setting |
| `MAX_PARALLEL_MODULE_AGENTS` | `4` | Module concurrency within one session, separate from site-wide concurrency |

Core scripts also accept `SVG_TRANSFORM_CORE_CONTAINER` (default `svg-transform-core`), `SVG_TRANSFORM_CORE_PORT`, and `SVG_TRANSFORM_CORE_ENV_FILE`. Most installations can keep the defaults. With a custom port, ensure the gateway URL matches the container mapping. Additional Core environment files can contain credentials and must remain private.

Relative workspace and data paths resolve from the repository root. An absolute path is recommended for a custom model file.

The development frontend uses the `/transformer/` base path and port `5173`. It reads `PORT` from the root `.env` to select the gateway proxy port. If an external `ENV_FILE` changes that port, explicitly pass the same `PORT` to the frontend process; Vite does not read that external file itself.

## Online operating settings

Use `/transformer/admin/settings` to change:

- Browser-based task isolation.
- Daily upload quotas, quota time zone, and maximum SVG size.
- Estimated task duration.
- User showcase submissions and existing tasks' showcase status.
- Site-wide session concurrency, when Core supports the queue settings API.

Gateway policy is stored in `gateway-state.json` and applies to new requests immediately after saving, without a restart. Core separately persists execution concurrency. Estimated task duration affects wait estimates only. See [administration](administration.en.md) for details.

## Legacy environment imports

These variables support older installations:

| Variable | Purpose |
| --- | --- |
| `SVG_TO_HTML_DAILY_UPLOAD_LIMIT` | Imports daily uploads when online settings are first created |
| `SVG_TO_HTML_DAILY_QUOTA_TIME_ZONE` | Imports the quota time zone |
| `SVG_TO_HTML_ESTIMATED_TASK_MINUTES` | Imports estimated task duration |
| `SVG_TO_HTML_SHOWCASE_JOB_IDS` | Imports existing showcases |
| `SVG_TO_HTML_ADMIN_KEY` | Enables legacy administrator migration; not needed for new administrator setup |

Legacy operating values are imported only when `gateway-state.json` is absent. Once online settings exist, changing these variables or restarting does not overwrite saved policy. Do not delete runtime files to reload configuration. See [legacy administrator migration](administration.en.md#migrating-a-legacy-administrator-key).

## Applying changes

| Change | How it takes effect |
| --- | --- |
| Gateway operating policy | Save in the UI; new requests use it immediately and accepted tasks continue |
| Site-wide session concurrency | Save in Queue and concurrency; Core adjusts and persists it online |
| Gateway port, Core URL, or ledger location | Restart the gateway in a maintenance window and verify the data path |
| Models, Core image, or module concurrency | Recreate Core with no active tasks; check compatibility before changing image tags |

Keep environment files, real model configuration, and runtime data out of Git. See [backups and migration](deployment.en.md#backups-and-migration) for the complete backup scope.
