import path from "node:path";

import { evaluatePage, launchEdge } from "../../core/cdp.js";
import startStaticServer from "../../core/static-server.js";

/**
 * Post-merge render health check for framework (vue/react) output.
 *
 * After the final page verify, the rendered HTML for vue/react is produced by
 * inlining a real Vite-built JS bundle into `#app` / `#root`. If the bundle
 * compiles but throws at runtime (the classic symptom of an undeclared
 * `sourceData` / `data` reference), the mount point stays empty, the page is
 * effectively blank, and pixel diff alone doesn't surface *why*. The page
 * verify diff is high but the session was still being marked `completed`.
 *
 * This check loads the same render-output wrapper the verify step uses, waits
 * for the framework bundle to mount, and inspects the mount point. A blank
 * mount point (or a captured runtime error) is reported as a failure with a
 * concrete reason, so the caller can mark the session `failed` instead of
 * silently completing.
 */
type RenderHealthCheckResult = {
  ok: boolean;
  /** Human-readable reason when ok === false. */
  reason?: string;
};

const MOUNT_INSPECT_SCRIPT = `\
(() => {
  const iframe = document.getElementById('source');
  const doc = iframe && iframe.contentDocument;
  if (!doc) return { ok: false, reason: 'render iframe document unavailable' };
  const app = doc.getElementById('app');
  const root = doc.getElementById('root');
  const mount = app || root;
  if (!mount) {
    return { ok: false, reason: 'mount element (#app/#root) missing from rendered document' };
  }
  const childCount = mount.childElementCount;
  if (childCount > 0) return { ok: true, childCount };
  // Mount exists but is empty: the framework bundle either failed to mount
  // or threw before rendering. Capture any onerror the wrapper recorded.
  const errors = Array.isArray(window.__RENDER_RUNTIME_ERRORS__)
    ? window.__RENDER_RUNTIME_ERRORS__
    : [];
  const reason = errors.length
    ? 'mount empty; runtime errors: ' + errors.slice(0, 3).join(' | ')
    : 'mount element empty after framework render (bundle likely threw)';
  return { ok: false, reason, childCount: 0 };
})()
`;

export const checkFrameworkRenderHealth = async ({
  artifactDir,
  viewportHeight,
  viewportWidth,
}: {
  /** Artifact dir; the render-output.html wrapper lives next to render.png here. */
  artifactDir: string;
  viewportHeight: number;
  viewportWidth: number;
}): Promise<RenderHealthCheckResult> => {
  // The render-output.html wrapper is written by the render step into the
  // artifact dir; it iframes the render entry and sets window.__RENDER_READY__.
  const wrapperPath = path.join(artifactDir, "render-output.html");
  const server = await startStaticServer();
  const browser = await launchEdge();
  try {
    const relativeArtifact = path.relative(process.cwd(), wrapperPath);
    const url = `${server.origin}/${relativeArtifact.split(path.sep).join("/")}`;
    const result = await evaluatePage({
      expression: MOUNT_INSPECT_SCRIPT,
      port: browser.port,
      url,
      viewportHeight,
      viewportWidth,
    });
    if (result && typeof result === "object" && "ok" in result) {
      const value = result as { ok?: boolean; reason?: string };
      return {
        ok: Boolean(value.ok),
        reason: value.reason,
      };
    }
    return {
      ok: false,
      reason: `mount inspection returned unexpected value: ${JSON.stringify(result)}`,
    };
  } catch (error) {
    return {
      ok: false,
      reason: `render health check failed to evaluate: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  } finally {
    await browser.close();
    await server.close();
  }
};
