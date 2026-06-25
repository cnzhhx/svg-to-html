import path from "node:path";

import { buildFrameworkRenderEntry } from "../../core/framework-render.js";
import { assertOutputFormat } from "../../core/output-target.js";
import type { SessionOutputTarget } from "../../core/output-target.js";
import type { ResolvedSvgDesign } from "../../core/design-resolve.js";
import { writeTextFile } from "../../core/file-io.js";
import type {
  ModuleMergeOptions,
  ModuleMergeResolvedModule,
  ModuleMergeResult,
  ModulePlanSharedLayer,
  ModulePlan,
  ModuleMergeSkippedModule,
  ModuleSourceData,
} from "./types.js";
import {
  injectModuleCss,
  renderModuleCss,
  renderModuleSections,
  renderModuleSourceSections,
  renderSharedLayerSections,
  renderSharedLayerSourceSections,
  renderSingleModuleCss,
  rewriteModuleLocalAssetReferences,
  rewriteModuleLocalAssetReferencesInValue,
  replaceDesignPageContent,
} from "./html-render.js";
import {
  assertUniqueModuleIds,
  loadResolvedModule,
  normalizePlanModules,
  readModulePlan,
} from "./module-loader.js";
import {
  resolveModulePlanPath,
  resolveRenderEntryPath,
  resolveScaffoldRenderPath,
} from "./paths.js";
import {
  createFrameworkSourceDataPlan,
  type FrameworkSourceDataPlan,
} from "./source-data.js";
import { formatPx, readRequiredText, resolveConfiguredPath } from "./utils.js";
import { sanitizeFrameworkSourceEntry } from "./framework-source-sanitize.js";

const normalizeOutputFormat = assertOutputFormat;

const normalizeSharedLayers = ({
  modulePlan,
  renderEntryPath,
  planDir,
}: {
  modulePlan: Awaited<ReturnType<typeof readModulePlan>>;
  renderEntryPath: string;
  planDir: string;
}) =>
  (Array.isArray(modulePlan.sharedLayers) ? modulePlan.sharedLayers : [])
    .filter((layer): layer is ModulePlanSharedLayer =>
      Boolean(
        layer &&
        typeof layer.id === "string" &&
        layer.kind === "shared-underlay" &&
        layer.region,
      ),
    )
    .flatMap((layer) => {
      const sourceRef =
        typeof layer.svgPath === "string"
          ? layer.svgPath
          : typeof layer.relativePath === "string"
            ? layer.relativePath
            : undefined;
      if (!sourceRef) return [];
      const assetPath = resolveConfiguredPath(sourceRef, planDir);
      const htmlRef = `./${path
        .relative(path.dirname(renderEntryPath), assetPath)
        .replaceAll(path.sep, "/")}`;
      return [
        {
          ...layer,
          htmlRef,
          region: layer.region!,
        },
      ];
    });

type LoadModuleOutputsInput = {
  modulePlan: ModulePlan;
  modulesDir: string;
  options: ModuleMergeOptions;
  planDir: string;
  renderEntryPath: string;
};

type LoadModuleOutputsResult = {
  modules: ModuleMergeResolvedModule[];
  skippedModules: ModuleMergeSkippedModule[];
};

const loadModuleOutputs = async ({
  modulePlan,
  modulesDir,
  options,
  planDir,
  renderEntryPath,
}: LoadModuleOutputsInput): Promise<LoadModuleOutputsResult> => {
  const planModules = await normalizePlanModules({ modulePlan, modulesDir });
  assertUniqueModuleIds(planModules);

  const loadResults = await Promise.all(
    planModules.map(async (planEntry) => {
      try {
        return {
          module: await loadResolvedModule({
            modulePlan,
            modulesDir,
            renderEntryPath,
            planDir,
            planEntry,
          }),
        };
      } catch (error) {
        if (!options.skipInvalidModules) throw error;
        return {
          skipped: {
            error: error instanceof Error ? error.message : String(error),
            id: planEntry.id,
          },
        };
      }
    }),
  );
  const loadedModules = loadResults.flatMap((result) =>
    result.module ? [result.module] : [],
  );
  const skippedModules = loadResults.flatMap((result) =>
    result.skipped ? [result.skipped] : [],
  );
  const modules = loadedModules.flatMap((module) => {
    try {
      renderSingleModuleCss(module);
      return [module];
    } catch (error) {
      if (!options.skipInvalidModules) throw error;
      skippedModules.push({
        error: `${module.id}: module CSS could not be scoped for deterministic merge: ${error instanceof Error ? error.message : String(error)}`,
        id: module.id,
      });
      return [];
    }
  });

  return { modules, skippedModules };
};

const buildMergedModuleCss = ({
  modules,
}: {
  modules: ModuleMergeResolvedModule[];
}) => {
  return renderModuleCss(modules);
};

type MergePreviewDocumentResult = {
  sharedLayers: ReturnType<typeof normalizeSharedLayers>;
};

const mergePreviewDocument = async ({
  modulePlan,
  modules,
  planDir,
  renderEntryPath,
  scaffoldRenderPath,
}: {
  modulePlan: ModulePlan;
  modules: ModuleMergeResolvedModule[];
  planDir: string;
  renderEntryPath: string;
  scaffoldRenderPath: string;
}): Promise<MergePreviewDocumentResult> => {
  const scaffoldHtml = await readRequiredText(
    scaffoldRenderPath,
    "scaffold/base render HTML",
  );
  const mergedCss = buildMergedModuleCss({ modules });
  const sharedLayers = normalizeSharedLayers({
    modulePlan,
    renderEntryPath,
    planDir,
  });
  const sections = [
    renderSharedLayerSections(sharedLayers, "shared-underlay"),
    renderModuleSections(modules),
  ]
    .filter((section) => section.trim())
    .join("\n      ");

  const nextHtml = injectModuleCss({
    css: mergedCss,
    html: replaceDesignPageContent({ html: scaffoldHtml, sections }),
  });

  await writeTextFile(renderEntryPath, nextHtml);

  return {
    sharedLayers,
  };
};

const resolveSourceDesign = ({
  design,
  modulePlan,
}: {
  design?: ResolvedSvgDesign;
  modulePlan: ModulePlan;
}): ResolvedSvgDesign => {
  const width = design?.width ?? modulePlan.design?.width;
  const height = design?.height ?? modulePlan.design?.height;
  if (typeof width !== "number" || typeof height !== "number") {
    throw new Error(
      "framework source merge requires design width/height from options.design or module-plan.json",
    );
  }
  return {
    designName: design?.designName ?? modulePlan.design?.name ?? "DesignPage",
    height,
    scale: design?.scale ?? 1,
    svgPath: design?.svgPath ?? modulePlan.design?.svgPath ?? "",
    width,
  };
};

const createFrameworkBaseCss = ({
  design,
  mountId,
}: {
  design: ResolvedSvgDesign;
  mountId: "app" | "root";
}) => `\
* {
  box-sizing: border-box;
}

html,
body,
#${mountId} {
  margin: 0;
  min-height: 100%;
}

body {
  background: transparent;
  font-family: "Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", sans-serif;
}

.design-page {
  position: relative;
  width: ${formatPx(design.width)};
  height: ${formatPx(design.height)};
  overflow: hidden;
  background: transparent;
}
`;

const createVueSourceEntry = ({
  css,
  sourceDataPlan,
  sections,
}: {
  css: string;
  sourceDataPlan: FrameworkSourceDataPlan;
  sections: string;
}) => `\
<template>
  <main class="design-page">
      ${sections}
  </main>
</template>

<script setup lang="ts">
${[
  sourceDataPlan.statement,
]
  .filter((line): line is string => Boolean(line))
  .join("\n")}
</script>

<style>
${css}
</style>
`;

const createReactSourceEntry = ({
  cssFileName,
  sourceDataPlan,
  sections,
}: {
  cssFileName: string;
  sourceDataPlan: FrameworkSourceDataPlan;
  sections: string;
}) => `\
${[
  `import "./${cssFileName}";`,
]
  .filter((line): line is string => Boolean(line))
  .join("\n")}

export default function DesignPage() {
${sourceDataPlan.statement ? `  ${sourceDataPlan.statement}\n` : ""}\
  return (
    <main className="design-page">
      ${sections}
    </main>
  );
}
`;

const resolveEffectiveOutputTarget = ({
  modulePlan,
  options,
  renderEntryPath,
}: {
  modulePlan: ModulePlan;
  options: ModuleMergeOptions;
  renderEntryPath: string;
}): SessionOutputTarget | null => {
  if (options.outputTarget) return options.outputTarget;
  const outputFormat = modulePlan.outputFormat ?? "html";
  if (outputFormat === "html") {
    return {
      compareEntryPath: "",
      format: "html",
      renderEntryPath,
      sourceEntryPath: options.sourceEntryPath ?? modulePlan.sourceEntryPath ?? renderEntryPath,
    };
  }
  throw new Error(
    `${outputFormat} source merge requires a complete outputTarget`,
  );
};

const rewriteModulesForSourceEntry = ({
  modules,
  outputTarget,
}: {
  modules: ModuleMergeResolvedModule[];
  outputTarget: SessionOutputTarget;
}) =>
  modules.map((module) => ({
    ...module,
    moduleCss: rewriteModuleLocalAssetReferences({
      allowedAssets: module.allowedAssets,
      content: module.moduleCss,
      moduleDir: module.dir,
      moduleLocalAssetRefs: module.moduleLocalAssetRefs,
      renderEntryPath: outputTarget.sourceStylePath ?? outputTarget.sourceEntryPath,
    }),
    sourceFragment:
      module.sourceFragment === undefined
        ? undefined
        : rewriteModuleLocalAssetReferences({
            allowedAssets: module.allowedAssets,
            content: module.sourceFragment,
            moduleDir: module.dir,
            moduleLocalAssetRefs: module.moduleLocalAssetRefs,
            renderEntryPath: outputTarget.sourceEntryPath,
          }),
    // source-data.json carries structured data the source fragment binds to
    // (e.g. { image: "./assets/x.png" }). Rewrite its asset strings to the
    // correct path relative to the source entry, mirroring what we do for
    // preview.fragment.html / module.css — otherwise agents must guess the
    // final relative path and routinely get it wrong.
    sourceData:
      module.sourceData === undefined
        ? undefined
        : (rewriteModuleLocalAssetReferencesInValue({
            allowedAssets: module.allowedAssets,
            moduleDir: module.dir,
            moduleLocalAssetRefs: module.moduleLocalAssetRefs,
            renderEntryPath: outputTarget.sourceEntryPath,
            value: module.sourceData,
          }) as ModuleSourceData),
  }));

const mergeSourceEntry = async ({
  design,
  modulePlan,
  modules,
  outputTarget,
  sharedLayers,
}: {
  design?: ResolvedSvgDesign;
  modulePlan: ModulePlan;
  modules: ModuleMergeResolvedModule[];
  outputTarget: SessionOutputTarget | null;
  sharedLayers: ReturnType<typeof normalizeSharedLayers>;
}) => {
  if (!outputTarget) return {};
  if (outputTarget.format === "html") {
    return {
      sourceEntryPath: outputTarget.sourceEntryPath,
    };
  }

  const sourceDesign = resolveSourceDesign({ design, modulePlan });
  const sourceFormat = outputTarget.format;
  const sourceModules = rewriteModulesForSourceEntry({ modules, outputTarget });
  const sourceDataPlan = createFrameworkSourceDataPlan(sourceModules);
  const sourceCss = [
    createFrameworkBaseCss({
      design: sourceDesign,
      mountId: sourceFormat === "vue" ? "app" : "root",
    }),
    buildMergedModuleCss({ modules: sourceModules }),
  ]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
  const sourceSections = [
    renderSharedLayerSourceSections(
      sharedLayers,
      "shared-underlay",
      sourceFormat,
    ),
    renderModuleSourceSections(sourceModules, sourceFormat),
  ]
    .filter((section) => section.trim())
    .join("\n      ");

  if (sourceFormat === "vue") {
    await writeTextFile(
      outputTarget.sourceEntryPath,
      createVueSourceEntry({
        css: sourceCss,
        sourceDataPlan,
        sections: sourceSections,
      }),
    );
  } else {
    if (!outputTarget.sourceStylePath) {
      throw new Error("React source merge requires sourceStylePath");
    }
    // Sanitize before writing: rewrite `React.<API>` namespace references to
    // named imports and inject any missing React import so the merged source
    // does not throw `ReferenceError: React is not defined` at runtime under
    // the classic JSX runtime (the host import block above omits it).
    const reactSource = sanitizeFrameworkSourceEntry(
      createReactSourceEntry({
        cssFileName: path.basename(outputTarget.sourceStylePath),
        sourceDataPlan,
        sections: sourceSections,
      }),
      "react",
    );
    await writeTextFile(outputTarget.sourceEntryPath, reactSource);
    await writeTextFile(outputTarget.sourceStylePath, sourceCss);
  }

  await buildFrameworkRenderEntry({
    design: sourceDesign,
    outputTarget,
  });

  return {
    frameworkBuildDir: outputTarget.frameworkBuildDir,
    sourceEntryPath: outputTarget.sourceEntryPath,
    sourceStylePath: outputTarget.sourceStylePath,
  };
};

const mergeModulesIntoHtml = async (
  options: ModuleMergeOptions,
): Promise<ModuleMergeResult> => {
  const modulePlanPath = resolveModulePlanPath(options);
  const planDir = path.dirname(modulePlanPath);
  const modulesDir = options.modulesDir
    ? resolveConfiguredPath(options.modulesDir, planDir)
    : path.dirname(modulePlanPath);
  const modulePlan = await readModulePlan(modulePlanPath);
  const outputFormat = normalizeOutputFormat(
    modulePlan.outputFormat ?? options.outputTarget?.format ?? "html",
  );
  if (
    modulePlan.outputFormat &&
    options.outputTarget?.format &&
    modulePlan.outputFormat !== options.outputTarget.format
  ) {
    throw new Error(
      `module-plan outputFormat (${modulePlan.outputFormat}) does not match outputTarget format (${options.outputTarget.format})`,
    );
  }
  const effectiveModulePlan: ModulePlan = {
    ...modulePlan,
    outputFormat,
  };
  const renderEntryPath = resolveRenderEntryPath({
    modulePlan: effectiveModulePlan,
    renderEntryPath: options.renderEntryPath,
    planDir,
  });
  const scaffoldRenderPath = resolveScaffoldRenderPath({
    modulePlan: effectiveModulePlan,
    renderEntryPath,
    planDir,
    scaffoldRenderPath: options.scaffoldRenderPath,
  });
  const { modules, skippedModules } = await loadModuleOutputs({
    modulePlan: effectiveModulePlan,
    modulesDir,
    options,
    renderEntryPath,
    planDir,
  });
  const previewResult = await mergePreviewDocument({
    modulePlan: effectiveModulePlan,
    modules,
    planDir,
    renderEntryPath,
    scaffoldRenderPath,
  });
  const sourceResult =
    options.mergeSource === false
      ? {}
      : await mergeSourceEntry({
          design: options.design,
          modulePlan: effectiveModulePlan,
          modules,
          outputTarget: resolveEffectiveOutputTarget({
            modulePlan: effectiveModulePlan,
            options,
            renderEntryPath,
          }),
          sharedLayers: previewResult.sharedLayers,
        });

  return {
    renderEntryPath,
    ...sourceResult,
    moduleCount: modules.length,
    moduleIds: modules.map((module) => module.id),
    modulePlanPath,
    modulesDir,
    outputFormat,
    scaffoldRenderPath,
    skippedModuleIds: skippedModules.map((module) => module.id),
    skippedModules,

  };
};

export { mergeModulesIntoHtml };
