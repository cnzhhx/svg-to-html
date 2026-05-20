# AGENTS.md

## Project Overview

This repository is an SVG-to-HTML restoration project. It takes design SVG files from `workspace/sessions/...`, preprocesses them into layout/assets/OCR artifacts, asks model agents to rebuild the page as real HTML/CSS, then verifies the output with render diff, OCR, text geometry, layout lint, module-region checks, and final-output policy gates.

The service is a TypeScript ESM app. The HTTP entry is `src/server.ts`, mounted under `/transformer`. CLI tasks live in `src/cli/`. Session state and generated artifacts live under `workspace/`.

## Useful Commands

- Install dependencies: `pnpm install`
- Start the service: `pnpm start`
- Prepare local model config: `cp config/model-provider.example.json config/model-provider.json`
- Generate a design page: `pnpm exec tsx src/cli/generate-design.ts workspace/sessions/<session>/<design>.svg`
- Verify a design page: `pnpm exec tsx src/cli/verify-design.ts workspace/sessions/<session>/<design>.svg`
- Fast visual verify: `pnpm exec tsx src/cli/verify-design.ts workspace/sessions/<session>/<design>.svg --fast`
- Type check: `pnpm exec tsc --noEmit`

If a session has `artifacts/modules/module-regions.diff.json`, append `--regions workspace/sessions/<session>/artifacts/modules/module-regions.diff.json` to verify commands so module-level diff is reported.

## Code Map

- `src/core/`: deterministic preprocessing, scaffold generation, SVG/container layout extraction, OCR, rendering, diffing, text/layout reports, workflow lint, final-output policy.
- `src/pipeline/agent-runner/`: top-level agent orchestration, feedback loops, checkpoints, verification gates, rollback, deterministic text tuning.
- `src/pipeline/module-agents/`: per-module agent packaging, prompts, validation, diagnostics, retry support.
- `src/pipeline/module-merge/`: merges module fragments into the final HTML and text layout.
- `src/pipeline/verify/`: feedback prompt/report generation and verify gate formatting.
- `src/routes/`: upload/job/preprocess/event APIs.
- `src/session-store/`: session persistence, progress, events, snapshots, messages.
- `prompts/`: long-form restoration rules injected into agent prompts.
- `public/`: frontend assets served by the Express app.
- `config/model-provider.example.json`: example model provider definitions for local setup.

## Agent Context Rules

- You may read this file, `agent.md`, `package.json`, `prompts/`, `docs/`, and relevant `src/` files when project context helps. Prefer targeted `rg --files`/`rg` searches and avoid `node_modules`.
- Project files explain tooling and policy. They are not design sources. For visual restoration decisions, trust the target SVG, same-session artifacts, allowed assets, OCR/layout reports, screenshots, and explicit user input.
- Keep edits scoped to the requested behavior. Do not revert unrelated user changes.
- Follow narrower task prompts over this file when a sub-agent is explicitly assigned a constrained write area such as a single module output directory.

## Restoration Rules

- The final `*.html` must be real HTML/CSS, not an embedded original SVG viewer.
- Do not reference, inline, crop, or repackage the whole original design SVG as the final visual layer.
- All ordinary visible text must be real DOM text. Do not bake readable UI text into image/SVG crops.
- Text nodes and text containers must not use transform-based scaling or skewing to fix geometry. Use normal typography and positioning.
- Pre-extracted assets are preferred for complex, bounded, text-free shells, backgrounds, icons, gradients, and bitmap content. If an asset contains ordinary readable text, split it or rebuild the text in DOM.
- Build semantic container structure first: page -> section/module -> header/nav/toolbar/list/card/item/text-area. Do not flatten large groups of text, icons, and decoration into one absolute-positioned layer.
- Repeated SVG/container groups should become a common list/grid/row parent with consistent item/card structure.

## Code Quality Rules

- Only use generic, universal rules in prompts, heuristics, and validation logic. Never hardcode domain-specific examples, product names, campaign names, or scenario-specific patterns. Rules must apply equally to any design input without modification.
- If a rule cannot be expressed without referencing a specific UI pattern by name, it is too narrow and must be generalized.

## Verification Guidance

- Batch related fixes before running verification. Do not run verify after every single `left`, `top`, font-size, text, or color tweak.
- A single agent turn may run `verify-design` at most 4 times. Before each verify, fix as many high-priority issues as can be judged from the current reports, then close the repair/verify loop within those 4 runs.
- Use `--fast` for low-cost visual direction checks.
- Use full verify when OCR, text boxes, layout boxes, workflow lint, or final-output policy diagnostics matter.
- If repeated small tweaks stop improving diff meaningfully, keep confirmed improvements and report the remaining risk instead of chasing unstable pixels.
