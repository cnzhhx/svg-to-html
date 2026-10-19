# Contributing

[Home](README.en.md) · [简体中文](CONTRIBUTING.md)

Contributions can include bug fixes, clearer documentation, shareable conversion examples, and ideas for new interactions or features. For larger changes, open an Issue describing the use case and intended behavior first.

## Repository structure

```text
svg-to-html/
├── frontend/src/             # React + TypeScript workspace and administration
│   ├── api/                  # Gateway requests and event streams
│   ├── components/           # Upload, comparison, chat, and administrator UI
│   ├── state/                # Application state
│   └── utils/                # Artifact, cache, and display helpers
├── backend/
│   ├── src/access/           # Anonymous ownership, administrator auth, and artifact access
│   ├── src/core-service/     # Core client and response adaptation
│   ├── src/routes/           # Gateway APIs
│   ├── src/settings/         # Persistent operating policy
│   ├── config/               # Model template; real configuration stays private
│   └── tests/                # Tests using a mock Core
├── scripts/                  # Development, deployment, release, and rollback scripts
├── docs/guides/              # Chinese and English user and deployment guides
├── example/                  # Public comparison examples
└── .env.example              # Environment template
```

The gateway uses Express; the frontend uses React and Vite. The conversion engine is maintained separately in [svg-transform-core](https://github.com/cnzhhx/svg-transform-core). This application connects through Docker and the Core client.

## Local development

Follow the [README quick start](README.en.md#quick-start) to install dependencies and configure models, then run `pnpm dev`. It prepares missing configuration and starts Core. If the configured image or runtime options differ, the startup helper can recreate an existing Core container.

### Connecting to an existing Core

If you have a Core instance to retain, set `SVG_TRANSFORM_CORE_URL` and the matching model configuration path in `.env`, then start the application development servers separately:

```bash
# Terminal one: gateway
pnpm -C backend dev
```

```bash
# Terminal two: frontend
pnpm dev:frontend
```

These commands do not manage Core containers. The frontend proxies `/transformer/api` to the gateway. Keep proxy and gateway ports aligned when changing `PORT`; see [configuration](docs/guides/configuration.en.md#environment-variables).

### Validation commands

Run from the repository root:

```bash
pnpm test              # Release rollback and gateway tests using a mock Core
pnpm build             # Build the frontend and check gateway types
pnpm lint:frontend     # Frontend TypeScript checks
pnpm audit             # Optional: dependency security audit
pnpm doctor            # Optional: local dependencies, configuration, and Core health
```

Tests require no real model credentials and submit no paid conversions. Changes to access, settings, or administrator behavior should pass the first three checks. For documentation, check links, commands, configuration names, and both language versions. Examples must not contain personal deployment targets.

Coverage includes operating policy persistence and revision conflicts, write failures, administrator migration and recovery, quotas and cross-date refunds, access permissions, stream revocation, path traversal, preview policy, and release data preservation.

Optional browser security verification requires local Chrome and Playwright. Set `ARTIFACT_TEST_PLAYWRIGHT_PATH` to the absolute path of Playwright's `index.mjs`, then run `pnpm test`. Browser tests must use isolated contexts and temporary runtime directories, without using or resetting personal profiles.

## Reporting issues

Include reproduction steps, expected and actual results, and your operating system, Node.js, pnpm, Core image version, and output format. Before sharing necessary logs or a minimal SVG, remove model credentials, cookies, administrator tokens, personal deployment details, and private design content.

For authentication bypasses or sensitive data exposure, keep public Issues limited to the impact. Do not include real credentials, runtime ledgers, or directly exploitable production details.

## Pull requests

- Keep each change focused on one problem and explain its trigger, resulting behavior, and validation.
- Include before-and-after screenshots for UI changes when useful; maintain the matching language version for documentation changes.
- Preserve existing work, local configuration, and runtime data. Avoid unrelated changes to the independent Core or legacy application directories.
- Exclude `.env`, real model files, `workspace/`, state ledgers, and other runtime data. Local planning notes under `docs/` are not public guides.
- Completing a local implementation does not imply publishing or deployment. See the [release guide](docs/guides/deployment.en.md#application-releases) for website releases.

Retain the [MIT License](LICENSE) and existing copyright notices in code and documentation contributions.
