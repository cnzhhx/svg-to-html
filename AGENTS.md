# AGENTS.md

## Project Overview

This repository is an SVG-to-HTML restoration toolkit. It takes design SVG files from `workspace/sessions/...`, preprocesses them into layout/assets/module artifacts, asks model agents to rebuild the page as real HTML/CSS (or Vue/React), then verifies the output with render diff.

The service is a TypeScript ESM app. The HTTP entry is `src/server.ts`, mounted under `/transformer` (default port `81`). CLI tasks live in `src/cli/`. Session state and generated artifacts live under `workspace/`. Agent prompts live in `src/prompts/`. Model/runtime selection is configured in `config/model-provider.json`.

## Useful Commands

- Install dependencies: `pnpm install`
- Start the service: `pnpm start`
- Build the MCP browser-eval server: `pnpm run build:mcp`
- Generate a design page: `pnpm exec tsx src/cli/generate-design.ts workspace/sessions/<session>/<design>.svg --format html|vue|react`
- Verify a design page: `pnpm exec tsx src/cli/verify-design.ts workspace/sessions/<session>/<design>.svg --render-entry workspace/sessions/<session>/<design>.html`
- Fast visual verify: append `--fast` (alias for `--mode fast`) to the verify command above
- Module-level local verify: `pnpm exec tsx src/cli/verify-module-design.ts --module-dir workspace/sessions/<session>/artifacts/modules/<module>/`
- Browser DOM query (debug): `pnpm exec tsx src/cli/browser-query.ts workspace/sessions/<session>/artifacts/modules/<module>/ --script '<js expression>'`
- Type check: `pnpm exec tsc --noEmit`

`verify-design` accepts only `--render-entry`/`--render-entry-path`, `--mode fast|full`, `--fast`, and `--scale`. It renders the SVG and the render entry to PNG and reports a single page-level pixel `diffRatio`. Module-level region diff is produced inside the module pipeline (`agent-runner/module-local-verify.ts`, `module-framework-local-verify.ts`), not by this CLI; do not pass a `--regions` flag (it is rejected as an unknown option).

## Code Map

- `src/core/`: deterministic preprocessing, scaffold generation, SVG/container layout extraction, module SVG cropping, rendering, pixel diff, asset metadata, text-blocks/style inference, module planning, browser/CDP infrastructure, framework render, and component-library registry.
- `src/pipeline/agent-runner/`: top-level session orchestration (`session-runner.ts`), preflight preprocessing (`preflight.ts`), the unified module pipeline (`module-pipeline-v2.ts`), per-module agent units, semantic preprocessing passes, local/visual verification, checkpoints, verify gates, rollback, concurrency control, run queue, agent turn core, workflow archive, module output contract/policy, and component adoption.
- `src/pipeline/agent-runtime/`: opencode runtime adapter selected from model-provider config.
- `src/pipeline/module-merge/`: merges per-module fragments, CSS, source-data bindings, and text layout into the final page output.
- `src/pipeline/component-library/`: compiles and manages reusable component libraries.
- `src/pipeline/verify.ts` + `src/pipeline/verify/`: render + pixel-diff verification entry and shared verify types.
- `src/prompts/`: long-form restoration rules and prompt builders injected into agent prompts (`module-agent.ts`, `planner.ts`, `semantic.ts`, `shared-rules.ts`, `component-library.ts`).
- `src/config/`: runtime thresholds, agent reasoning effort, and model-provider/runtime resolution.
- `src/routes/`: upload/job/events/component-library HTTP APIs.
- `src/session-store/`: session persistence, progress, events, snapshots, messages.
- `src/mcp/`: browser-eval MCP server exposing the `browser_eval` tool.
- `public/`: frontend assets served by the Express app.

## Agent Context Rules

- You may read this file, `README.md`, `package.json`, `src/prompts/`, `docs/`, and relevant `src/` files when project context helps. Prefer targeted `rg --files`/`rg` searches and avoid `node_modules`.
- Project files explain tooling and policy. They are not design sources. For visual restoration decisions, trust the target SVG, same-session artifacts, allowed assets, module semantic/text-layout inputs, screenshots, and explicit user input.
- Keep edits scoped to the requested behavior. Do not revert unrelated user changes.
- Follow narrower task prompts over this file when a sub-agent is explicitly assigned a constrained write area such as a single module output directory.

## Restoration Rules

- The final `*.html` must be real HTML/CSS, not an embedded original SVG viewer.
- Do not reference, inline, crop, or repackage the whole original design SVG as the final visual layer.
- All ordinary visible text must be real DOM text. The decision of whether a visual element is ordinary text (to be rendered as DOM text) or a visual asset is made during semantic preprocessing and reflected in `module-semantic.json`'s `textBlocks` and `generatedAssets`. Module agents must not independently infer readable text from images; they should only render `textBlocks` as DOM text and must not bake `textBlocks` text into image/SVG crops.
- Text nodes and text containers must not use transform-based scaling or skewing to fix geometry. Use normal typography and positioning.
- Pre-extracted assets are preferred for complex, bounded, text-free shells, backgrounds, icons, gradients, and bitmap content. If an asset contains ordinary readable text, split it or rebuild the text in DOM.
- Build semantic container structure first: page -> section/module -> header/nav/toolbar/list/card/item/text-area. Do not flatten large groups of text, icons, and decoration into one absolute-positioned layer.
- Repeated SVG/container groups should become a common list/grid/row parent with consistent item/card structure.

## Module Output Policy

Agents must respect the following output rules enforced by `src/pipeline/module-output-policy.ts` and the merge pipeline:

- Do not reference the original whole-page SVG, inline `<svg>`, or use `data:image` / base64 data URIs.
- Generated assets must be placed under the module `assets/` directory, declare a `box`, and point to real files.
- `mustUse` assets must actually be referenced in the source fragment.
- CSS complexity is capped: `MODULE_CSS_MAX_BYTES` (320 KB), `MODULE_CSS_MAX_GRADIENTS` (80), `MODULE_CSS_MAX_BOX_SHADOW_LAYERS` (180), `MODULE_CSS_MAX_POLYGON_POINTS` (160).
- A generated asset that visually covers ≥92% of the module area must have a concrete visual asset role.
- Do not create a full-bleed gradient visual layer that approximates the whole page background.
- Vue/React source fragments must not contain `import/export`, `<template>/<script>/<style>`, or component declarations.
- Structured data should be placed in `source-data.json` rather than inlined in props, `v-for`, or inline maps.

## Code Quality Rules

- Only use generic, universal rules in prompts, heuristics, and validation logic. Never hardcode domain-specific examples, product names, or scenario-specific patterns (e.g., "X区", "Y榜", "Z活动"). Rules must apply equally to any design input without modification.
- If a rule cannot be expressed without referencing a specific UI pattern by name, it is too narrow and must be generalized.

## Verification Guidance

- Batch related fixes before running verification. Do not run verify after every single `left`, `top`, font-size, text, or color tweak.
- A single agent turn may run `verify-design` at most 4 times. Before each verify, fix as many high-priority issues as can be judged from the current reports, then close the repair/verify loop within those 4 runs.
- Use `--fast` for low-cost visual direction checks; use full verify (default) when you need the higher-fidelity page diff.
- If repeated small tweaks stop improving diff meaningfully, keep confirmed improvements and report the remaining risk instead of chasing unstable pixels.

## Pipeline At A Glance

A session runs through two phases (see `src/pipeline/agent-runner/`):

1. Preflight (`preflight.ts`, deterministic):
   - resolve container layout
   - build semi-auto scaffold (shell assets)
   - initialize format scaffolds (html/vue/react entries)
   - plan adaptive modules (`src/core/svg-vertical-modules.ts`)
   - crop per-module SVGs
   - publish preflight artifacts
   Small/low-complexity pages are kept as one full-page module; otherwise the model planner is used and falls back to a single module on failure.
2. Module pipeline v2 (`module-pipeline-v2.ts`):
   - per module, run semantic preprocessing (element analysis -> text blocks -> text-style inference -> `module-semantic.json`)
   - if a component library is enabled, generate adoption plan and context
   - run the module agent in parallel (limited by `MAX_PARALLEL_MODULE_AGENTS`)
   - execute `verify-design`, `verify-module-design`, or MCP `browser_eval` commands inside the agent turn, with automatic backup/rollback based on diff improvement or degradation
   - collect local/framework visual verify results and restore best mergeable snapshots
   - merge fragments into the final page
   - run page-level verify

Agent runtimes are pluggable (`agent-runtime/`) and currently only `opencode` is supported. They are chosen from `config/model-provider.json`: `moduleAgentModel` selects module generation/repair agents, and `otherModel` selects planner, semantic, and other support agents. Role-aware env overrides are available via `MODULE_AGENT_*`, `TEXT_*`, and `VISION_*`.
