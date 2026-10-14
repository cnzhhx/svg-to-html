# Application maintenance

This repository is the shared application for self-hosting and hosted trials. Keep one implementation of the frontend and API gateway. Operating policies are stored by the gateway and edited through its administrator pages.

- Preserve existing work, local configuration, and runtime data. The adjacent ToC directory is a migration source, not a second active application to update automatically.
- Do not modify the adjacent Core project, its running image, model configuration, or conversion concurrency unless explicitly requested.
- Do not publish to GitHub or deploy a website merely because local implementation is complete.
- Explicit website releases use `pnpm publish:app` (`publish:toc` is an alias). The operator supplies `TOC_DEPLOY_HOST`, `TOC_DEPLOY_DIR`, and `TOC_DEPLOY_URL`. Never add personal deployment addresses or credentials to source.
- Preserve staging verification, backups, rollback, and the active-job guard. Never terminate jobs to force a release.
- Runtime files, including `gateway-state.json`, `access-state.json`, environment files and model-provider credentials, must not enter Git or code snapshots.
- Run `pnpm test`, `pnpm build`, and `pnpm lint:frontend` for changes affecting access, settings or admin behavior. Use a mock Core for tests; do not submit paid conversions.
- Browser QA must use isolated browser contexts and a temporary runtime directory. Do not reset the user's browser profile or application data.
