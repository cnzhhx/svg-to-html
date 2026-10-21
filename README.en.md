<div align="center">

# SVG to HTML

Turn SVG designs into HTML, Vue, React, or Flutter. Compare results, refine modules, and download source code in your browser.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![React](https://img.shields.io/badge/React-18-149eca.svg)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6.svg)](https://www.typescriptlang.org/)
[![Core: Docker](https://img.shields.io/badge/Core-Docker-2496ed.svg)](https://github.com/cnzhhx/svg-transform-core)

[简体中文](README.md) | English

[Live demo](https://lkti.cloud/transformer/) · [Example](#example) · [Quick start](#quick-start) · [Deployment](docs/guides/deployment.en.md) · [Contributing](CONTRIBUTING.en.md)

Community: [LINUX DO](https://linux.do/)

</div>

## Overview

SVG to HTML is a web workspace for uploading designs, reviewing generated pages, refining individual modules, and exporting code. Use it locally to turn SVG page designs into frontend implementations, or host an instance for your team or visitors.

This repository contains the React frontend and API gateway. The independent [svg-transform-core](https://github.com/cnzhhx/svg-transform-core) Docker service performs conversions. Self-hosted instances and hosted trials share the same application. Operators configure the model provider; real conversions call that provider's model API.

## Features

| Feature | What it does |
| --- | --- |
| Multiple output formats | Choose HTML, Vue, React, or Flutter when enabled by Core, with 1× or 2× render scale |
| Conversion progress | Follow the queue, workflow stages, module execution, and conversation history |
| Visual comparison | Compare designs and results side by side or with a slider, adjust preview width, and inspect visual differences |
| Module refinement | Select a module and send specific adjustment requests through chat |
| Source delivery | Open comparison pages, source, or rendered previews; download complete deliverables or diagnostics and inspect separate quality results |
| Public showcases | Share selected conversion results with all visitors; administrators manage showcase status |
| Site administration | Configure access isolation, daily quotas, upload limits, and queue concurrency in the browser |

## Example

![Comparison of an SVG design and generated HTML](example/comparison-4.33.png)

This sample has a **4.33%** visual difference. [Download the interactive comparison](example/comparison-4.33.html) and open it in a browser. Results depend on the design, model, and configuration; the number applies to this sample only.

## Quick start

### 1. Requirements

| Dependency | Requirement |
| --- | --- |
| Node.js | Node.js 22 LTS, at least 22.12, recommended; Node.js 20 at version 20.19+ is also supported |
| pnpm | 10.11.0, matching the repository's `packageManager` |
| Docker | Installed, with the Docker daemon running |
| Command line | Git, Bash, and curl; use the commands below on macOS / Linux, or use WSL2 on Windows |
| Model provider | A model that accepts text and images, with valid API credentials |

If pnpm is not installed, run `npm install -g pnpm@10.11.0`.

### 2. Clone and configure

These steps are for a fresh clone. Retain existing configuration and runtime data when upgrading.

```bash
git clone https://github.com/cnzhhx/svg-to-html.git
cd svg-to-html
pnpm install --frozen-lockfile

cp .env.example .env
cp backend/config/model-provider.example.json backend/config/model-provider.json
```

Edit `backend/config/model-provider.json` and replace the example `baseURL`, `apiKey`, and `model` with your provider's values. Each key under `models` becomes a model configuration ID in the upload dialog. See the [configuration guide](docs/guides/configuration.en.md) for the full format.

### 3. Start the application

```bash
pnpm dev
```

The script pulls the configured Core image if it is missing locally, starts Core, and starts the frontend and gateway. The initial image download may take some time. Missing environment and model configuration files are copied from templates, but conversions still require valid model credentials.

Open [http://localhost:5173/transformer/](http://localhost:5173/transformer/). The gateway defaults to port `8081`, and Core to `4310`. To connect development servers to an existing Core, see [Contributing](CONTRIBUTING.en.md#connecting-to-an-existing-core).

### 4. Create an administrator

In another terminal at the project root, run:

```bash
pnpm admin:setup-token
```

Open the [setup page](http://localhost:5173/transformer/setup). Use the token printed in your terminal to create an administrator account with a password of at least 12 characters. The token is single-use and expires after 15 minutes.

Use the [login page](http://localhost:5173/transformer/login) to access [site settings](http://localhost:5173/transformer/admin/settings). Ordinary visitors do not need accounts. On a server, administrator commands must use the service's environment and runtime path; see [deployment](docs/guides/deployment.en.md#administrator-setup).

## Using the workspace

1. Click the SVG upload button and choose a design, output format, render scale, and model configuration.
2. Follow the queue status, conversion progress, and module execution.
3. Compare the design and result side by side or with the slider. To refine the result, select a module and enter a request in the chat panel.
4. Open the source or rendered preview, download the ZIP, and continue development using the generated project's structure.

Tasks are isolated by browser by default. A task submitted as a public showcase is visible to other visitors. Anonymous ownership is stored through browser cookies; clearing cookies or switching browsers does not automatically restore access to previous tasks.

## Documentation

| Guide | Contents |
| --- | --- |
| [Configuration](docs/guides/configuration.en.md) | Models, environment variables, ports, data paths, and applying changes |
| [Administration](docs/guides/administration.en.md) | Setup and recovery, access isolation, quotas, showcases, and concurrency |
| [Deployment and maintenance](docs/guides/deployment.en.md) | Ubuntu installation, reverse proxying, releases, backups, migration, and troubleshooting |
| [Contributing](CONTRIBUTING.en.md) | Repository structure, development, validation, and Issue / PR guidance |
| [Conversion engine](https://github.com/cnzhhx/svg-transform-core) | The independent Core service and its implementation |

## Server deployment

The repository includes an initial Ubuntu installer. It installs Node.js, pnpm, Docker, and Nginx, builds the application, and configures a systemd service. After cloning the repository on the server, run from the project root:

```bash
sudo bash scripts/deploy-ubuntu.sh
```

The default entry is `http://YOUR_SERVER/transformer/`. Model configuration lives at `/etc/svg-to-html/model-provider.json`, and the environment at `/etc/svg-to-html/app.env`. Replace template placeholders with real values. The installer configures system services and Nginx; read [deployment and maintenance](docs/guides/deployment.en.md) before using it on a server with existing sites.

For subsequent application releases, use `pnpm publish:app` with your target server, directory, and URL. The release process includes staging checks, backups, rollback on activation failure, and an active-job guard. See [application releases](docs/guides/deployment.en.md#application-releases).

## FAQ

**Can I upload PNG, Figma links, or PDF?**

The upload endpoint currently accepts SVG files. Export designs from other tools to SVG first.

**Do I need a model API key just to open the UI?**

The UI can start with placeholder configuration. Real conversions require valid model configuration and an available Core. Provider credentials remain server-side.

**Are conversion speed and visual fidelity guaranteed?**

Duration and visual differences depend on design complexity, model capability, provider availability, and queue conditions. Wait times are estimates; the sample's difference score is not a guarantee for other tasks.

**Where do I change quotas and concurrency?**

Use the administrator settings page. The gateway persists access policy, quotas, and showcase settings; a Core with the required API persists site-wide execution concurrency. See [administration](docs/guides/administration.en.md).

**Can I expose an instance to the public?**

Configure HTTPS, ingress rate limits, and backups first, and read the [preview script trust boundary](docs/guides/deployment.en.md#preview-and-access-security). Anonymous browser identities are not full user accounts, and scripts in generated pages must be treated as trusted code.

## Contributing

Use [Issues](https://github.com/cnzhhx/svg-to-html/issues) to report bugs or discuss ideas, and Pull Requests to improve code, documentation, or examples. Read the [contribution guide](CONTRIBUTING.en.md) before submitting changes.

## License

This repository uses the [MIT License](LICENSE). Retain copyright and license notices when using or distributing it. See the independent Core project and third-party dependencies for their respective licenses.
