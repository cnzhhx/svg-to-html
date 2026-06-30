import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";

import type { ResolvedDesignTarget } from "../../../core/design-resolve.js";
import { writeJsonFile } from "../../../core/file-io.js";
import { sessionStore } from "../../../session-store.js";
import { mergeModulesIntoHtml, readModulePlan } from "../../module-merge/index.js";
import { finalizeModuleManifest } from "../../module-merge/finalize-module-manifest.js";
import type { ModulePlan, ModulePlanModule } from "../../module-merge/types.js";

type PublishLivePreviewInput = {
  design: ResolvedDesignTarget;
  modulePlanPath: string;
  scaffoldHtmlPath: string;
  sessionId: string;
};

const previewLocks = new Map<string, Promise<void>>();
const requestedPreviewRefreshes = new Map<
  string,
  {
    input: PublishLivePreviewInput;
    requested: boolean;
    running: boolean;
  }
>();

const toModulePlanModules = (modulePlan: ModulePlan) => {
  const rawModules = modulePlan.modules;
  const modules: ModulePlanModule[] = Array.isArray(rawModules)
    ? rawModules.map((module) => ({ ...module, id: String(module.id) }))
    : Object.entries(rawModules ?? {}).map(([id, value]) => ({
        ...(typeof value === "object" && value ? value : {}),
        id,
      }));

  return modules
    .filter((module) => module.id)
    .map((module) => ({
      id: module.id,
      ...(typeof module.kind === "string" ? { kind: module.kind } : {}),
      ...(module.region && typeof module.region === "object"
        ? { region: module.region as Record<string, unknown> }
        : {}),
    }));
};

const buildLivePreviewPlan = (modulePlan: ModulePlan): ModulePlan => ({
  ...modulePlan,
  outputFormat: "html",
});

const livePreviewFitStart = "<!-- live-preview-fit:start -->";
const livePreviewFitEnd = "<!-- live-preview-fit:end -->";

const readPositiveNumber = (value: unknown, fallback: number) => {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0
    ? numberValue
    : fallback;
};

const buildLivePreviewFitBlock = ({
  height,
  width,
}: {
  height: number;
  width: number;
}) => `${livePreviewFitStart}
    <style data-live-preview-fit>
      :root {
        --live-preview-scale: 1;
      }

      html,
      body {
        width: 100%;
        min-height: 100vh;
        min-width: 0;
        margin: 0;
        overflow-x: hidden;
        background: transparent;
      }

      .live-preview-scale-shell {
        position: relative;
        width: 100%;
        height: ${Math.round(height)}px;
        overflow: hidden;
        background: transparent;
      }

      .live-preview-scale-shell > .design-page {
        transform: scale(var(--live-preview-scale));
        transform-origin: 0 0;
      }

      .design-module.live-preview-selected-module {
        outline: 0 !important;
        outline-offset: 0 !important;
        box-shadow: none !important;
      }

      .live-preview-module-highlight {
        position: fixed;
        box-sizing: border-box;
        pointer-events: none;
        border: 3px solid #0ea5e9;
        border-radius: 2px;
        box-shadow: none;
        z-index: 2147483646 !important;
      }
    </style>
    <script>
      (() => {
        const designWidth = ${JSON.stringify(width)};
        const designHeight = ${JSON.stringify(height)};
        const root = document.documentElement;
        const shell = () => document.querySelector(".live-preview-scale-shell");
        const activeModuleId = new URLSearchParams(window.location.search).get("module");
        let didScrollToModule = false;
        const activeModule = () => Array.from(document.querySelectorAll(".design-module[data-module-id]"))
          .find((element) => element.getAttribute("data-module-id") === activeModuleId);
        const overlay = () => {
          let element = document.getElementById("live-preview-module-highlight");
          if (!element) {
            element = document.createElement("div");
            element.id = "live-preview-module-highlight";
            element.className = "live-preview-module-highlight";
            document.body.appendChild(element);
          }
          return element;
        };
        const positionOverlay = (moduleElement) => {
          const element = overlay();
          const rect = moduleElement.getBoundingClientRect();
          const inset = 3;
          const left = Math.max(inset, rect.left + inset);
          const top = Math.max(inset, rect.top + inset);
          const right = Math.min(window.innerWidth - inset, rect.right - inset);
          const bottom = Math.min(window.innerHeight - inset, rect.bottom - inset);
          if (right <= left || bottom <= top) {
            element.style.display = "none";
            return;
          }
          element.style.display = "block";
          element.style.left = left + "px";
          element.style.top = top + "px";
          element.style.width = (right - left) + "px";
          element.style.height = (bottom - top) + "px";
        };
        const highlight = () => {
          if (!activeModuleId) return;
          document.querySelectorAll(".design-module.live-preview-selected-module")
            .forEach((element) => element.classList.remove("live-preview-selected-module"));
          const moduleElement = activeModule();
          if (!moduleElement) return;
          moduleElement.classList.add("live-preview-selected-module");
          positionOverlay(moduleElement);
          if (didScrollToModule) return;
          didScrollToModule = true;
          const moduleRect = moduleElement.getBoundingClientRect();
          const targetTop = window.scrollY + moduleRect.top + moduleRect.height / 2 - window.innerHeight / 2;
          window.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
          window.requestAnimationFrame(() => positionOverlay(moduleElement));
        };
        const update = () => {
          const scale = Math.max(0.01, window.innerWidth / designWidth);
          const scaledHeight = Math.ceil(designHeight * scale);
          root.style.setProperty("--live-preview-scale", String(scale));
          const element = shell();
          if (element) {
            element.style.height = scaledHeight + "px";
            element.style.marginTop = Math.max(0, Math.floor((window.innerHeight - scaledHeight) / 2)) + "px";
          }
          window.requestAnimationFrame(highlight);
        };
        window.addEventListener("resize", update, { passive: true });
        window.addEventListener("scroll", () => window.requestAnimationFrame(highlight), { passive: true });
        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", update, { once: true });
        } else {
          update();
        }
      })();
    </script>
    ${livePreviewFitEnd}`;

const wrapDesignPageForLivePreview = (html: string) => {
  if (html.includes('class="live-preview-scale-shell"')) return html;
  const designPagePattern =
    /(<main\b[^>]*class=(["'])[^"']*\bdesign-page\b[^"']*\2[^>]*>[\s\S]*?<\/main>)/i;
  if (!designPagePattern.test(html)) return html;
  return html.replace(
    designPagePattern,
    '<div class="live-preview-scale-shell">\n    $1\n    </div>',
  );
};

const applyLivePreviewFit = ({
  height,
  html,
  width,
}: {
  height: number;
  html: string;
  width: number;
}) => {
  const block = buildLivePreviewFitBlock({ height, width });
  const existingPattern = new RegExp(
    `${livePreviewFitStart}[\\s\\S]*?${livePreviewFitEnd}`,
    "m",
  );
  const withFitBlock = existingPattern.test(html)
    ? html.replace(existingPattern, block)
    : html.replace("</head>", `    ${block}\n  </head>`);
  return wrapDesignPageForLivePreview(withFitBlock);
};

const writeFittedLivePreview = async ({
  livePreviewPath,
  modulePlan,
}: {
  livePreviewPath: string;
  modulePlan: ModulePlan;
}) => {
  const html = await readFile(livePreviewPath, "utf8");
  await writeFile(
    livePreviewPath,
    applyLivePreviewFit({
      height: readPositiveNumber(modulePlan.design?.height, 900),
      html,
      width: readPositiveNumber(modulePlan.design?.width, 1440),
    }),
    "utf8",
  );
};

const writeLivePreviewPlan = async ({
  livePlanPath,
  modulePlan,
}: {
  livePlanPath: string;
  modulePlan: ModulePlan;
}) => {
  await writeJsonFile(livePlanPath, buildLivePreviewPlan(modulePlan));
};

const writeLivePreviewPlaceholder = async ({
  livePreviewPath,
  modulePlan,
}: {
  livePreviewPath: string;
  modulePlan: ModulePlan;
}) => {
  const width = readPositiveNumber(modulePlan.design?.width, 1440);
  const modules = toModulePlanModules(modulePlan);
  await writeFile(
    livePreviewPath,
    `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${Number.isFinite(width) ? width : 1440}, initial-scale=1" />
    <title>Live Preview</title>
    <style>
      html, body { margin: 0; width: 100%; min-height: 100%; overflow: hidden; background: #f3f6fb; color: #1f2937; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .live-preview-empty { width: 100vw; height: 100vh; display: grid; place-items: center; padding: 28px; }
      .live-preview-card { width: min(520px, calc(100vw - 56px)); max-height: calc(100vh - 56px); display: flex; flex-direction: column; padding: 24px; border: 1px solid #dbe4ef; border-radius: 16px; background: rgba(255,255,255,.9); box-shadow: 0 20px 60px rgba(31,41,55,.12); }
      h1 { margin: 0 0 8px; font-size: 26px; line-height: 1.2; }
      p { margin: 0 0 14px; color: #667085; font-size: 14px; }
      .module-list { min-height: 0; overflow: auto; display: grid; gap: 8px; }
      .module-row { display: flex; justify-content: space-between; gap: 16px; border: 1px solid #e5edf6; border-radius: 10px; padding: 9px 11px; background: #fff; font-size: 13px; }
      .module-row span:last-child { color: #8a9bb0; }
    </style>
  </head>
  <body>
    <main class="live-preview-empty">
      <section class="live-preview-card">
        <h1>正在生成</h1>
        <p>模块产物完成后，这里会自动切换为整页实时预览。</p>
        <div class="module-list">
          ${modules
            .map(
              (module) =>
                `<div class="module-row"><strong>${module.id}</strong><span>${module.kind ?? "module"}</span></div>`,
            )
            .join("\n          ")}
        </div>
      </section>
    </main>
  </body>
</html>
`,
    "utf8",
  );
};

const finalizeLivePreviewModuleManifests = async ({
  modulePlan,
  modulesRootDir,
  sessionId,
}: {
  modulePlan: ModulePlan;
  modulesRootDir: string;
  sessionId: string;
}) => {
  const modules = toModulePlanModules(modulePlan);
  await Promise.all(
    modules.map(async (module) => {
      try {
        await finalizeModuleManifest({
          moduleDir: path.join(modulesRootDir, module.id),
        });
      } catch (error) {
        sessionStore.addLog(
          sessionId,
          `[live-preview:${module.id}] finalize manifest warning: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
  );
};

const publishLivePreviewNow = async ({
  design,
  modulePlanPath,
  scaffoldHtmlPath,
  sessionId,
}: PublishLivePreviewInput) => {
  const modulePlan = await readModulePlan(modulePlanPath);
  const modulesRootDir = path.dirname(modulePlanPath);
  const artifactDir = path.dirname(modulesRootDir);
  const livePreviewPath = path.join(artifactDir, "live-preview.html");
  const livePlanPath = path.join(modulesRootDir, "live-preview-plan.json");
  await finalizeLivePreviewModuleManifests({
    modulePlan,
    modulesRootDir,
    sessionId,
  });
  await writeLivePreviewPlan({ livePlanPath, modulePlan });

  const mergeResult = await mergeModulesIntoHtml({
    design,
    mergeSource: false,
    modulePlanPath: livePlanPath,
    modulesDir: modulesRootDir,
    outputTarget: { ...design.outputTarget, format: "html" },
    renderEntryPath: livePreviewPath,
    scaffoldRenderPath: scaffoldHtmlPath,
    skipInvalidModules: true,
  });

  if (mergeResult.moduleCount === 0) {
    await writeLivePreviewPlaceholder({ livePreviewPath, modulePlan });
  } else {
    await writeFittedLivePreview({ livePreviewPath, modulePlan });
  }

  const latest = sessionStore.get(sessionId);
  if (!latest) return;
  const livePreviewUpdatedAt = Date.now();
  sessionStore.update(sessionId, {
    result: {
      ...latest.result,
      livePreviewEntryPath: livePreviewPath,
      livePreviewUpdatedAt,
      livePreviewVersion: Number(latest.result.livePreviewVersion ?? 0) + 1,
      modulePlanModules: toModulePlanModules(modulePlan),
    },
  });
};

const publishLivePreview = async (input: PublishLivePreviewInput) => {
  const previous = previewLocks.get(input.sessionId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => publishLivePreviewNow(input))
    .catch((error) => {
      sessionStore.addLog(
        input.sessionId,
        `[live-preview] refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  previewLocks.set(input.sessionId, next);
  await next;
  if (previewLocks.get(input.sessionId) === next) {
    previewLocks.delete(input.sessionId);
  }
};

const drainRequestedLivePreviewRefresh = async (sessionId: string) => {
  const state = requestedPreviewRefreshes.get(sessionId);
  if (!state || state.running) return;
  state.running = true;
  try {
    while (state.requested) {
      state.requested = false;
      await publishLivePreview(state.input);
    }
  } finally {
    state.running = false;
    if (state.requested) {
      void drainRequestedLivePreviewRefresh(sessionId);
    } else {
      requestedPreviewRefreshes.delete(sessionId);
    }
  }
};

const requestLivePreviewRefresh = (input: PublishLivePreviewInput) => {
  const existing = requestedPreviewRefreshes.get(input.sessionId);
  if (existing) {
    existing.input = input;
    existing.requested = true;
    if (!existing.running) {
      void drainRequestedLivePreviewRefresh(input.sessionId);
    }
    return;
  }

  requestedPreviewRefreshes.set(input.sessionId, {
    input,
    requested: true,
    running: false,
  });
  void drainRequestedLivePreviewRefresh(input.sessionId);
};

export {
  publishLivePreview,
  requestLivePreviewRefresh,
  toModulePlanModules,
};
