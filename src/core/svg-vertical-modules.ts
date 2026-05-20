import path from "node:path";
import { readdir, unlink } from "node:fs/promises";

import { createContainerLayoutReport } from "./container-layout.js";
import {
  runCodexModulePlanner,
  toValidationSummary,
} from "./module-planner/codex-planner.js";
import { renderCodexPlannerPreviewImages } from "./module-planner/preview-images.js";
import type {
  ModulePlannerMetadata,
  ModulePlannerMode,
} from "./module-planner/types.js";
import { createModulePlanQualityReport } from "./module-plan-quality.js";
import { readSvgLayout } from "./svg-layout.js";
import {
  resolveArtifactDir,
  resolveSvgDesign,
  writeJsonFile,
  writeTextFile,
  type Box,
} from "./utils.js";
import { createMarkdown } from "./svg-vertical-modules/markdown.js";
import {
  normalizeOcrBlocks,
  normalizeShellManifest,
} from "./svg-vertical-modules/normalizers.js";
import { isSmallLowComplexityDesign } from "./svg-vertical-modules/route-heuristics.js";
import { createSinglePageModule } from "./svg-vertical-modules/single-planner.js";
import type {
  CreateAdaptiveModulePlanOptions,
  ModuleGap,
  ModulePlanMode,
  ModulePlanningRoute,
  PlannedModules,
  SvgVerticalModule,
  SvgVerticalModuleArtifacts,
  SvgVerticalModuleReport,
} from "./svg-vertical-modules/types.js";

const DEFAULT_PLANNER_RETRIES = 2;

const createPlannerConstraints = () => ({
  avoidSplittingCardsOrRepeatedItems: true,
  avoidSplittingVisibleText: true,
  preferSemanticSections: true,
  smallDecorationsBelongToNearestModule: true,
});

const clearPlannerArtifacts = async (moduleDir: string) => {
  let entries: string[];
  try {
    entries = await readdir(moduleDir);
  } catch {
    return;
  }

  await Promise.allSettled(
    entries
      .filter((entry) => entry.startsWith("planner-"))
      .map((entry) => unlink(path.join(moduleDir, entry))),
  );
};

const createAdaptiveModulePlan = async ({
  artifactDir: customArtifactDir,
  concurrencyLimit,
  containerLayoutReport,
  inputPath,
  minGap = 10,
  mode: requestedMode = "auto",
  ocrBlocks: ocrBlocksInput,
  planner: requestedPlanner = "auto",
  plannerRetries = DEFAULT_PLANNER_RETRIES,
  scale,
  shellManifest: shellManifestInput,
  svgLayoutReport,
}: CreateAdaptiveModulePlanOptions): Promise<SvgVerticalModuleArtifacts> => {
  const design = await resolveSvgDesign(inputPath, { scale });
  const artifactDir = await resolveArtifactDir(
    design.svgPath,
    customArtifactDir,
  );
  const moduleDir = path.join(artifactDir, "modules");
  await clearPlannerArtifacts(moduleDir);
  const viewport: Box = {
    height: design.height,
    width: design.width,
    x: 0,
    y: 0,
  };
  const ocrBlocks = normalizeOcrBlocks(ocrBlocksInput);
  const shellManifest = normalizeShellManifest(shellManifestInput);
  const warnings: string[] = [];
  const safePlannerRetries = Math.max(0, Math.floor(plannerRetries));
  const plannerConstraints = createPlannerConstraints();

  let svgLayout = svgLayoutReport;
  let containerLayout = containerLayoutReport;

  if (!containerLayout) {
    const created = await createContainerLayoutReport({
      artifactDir,
      inputPath: design.svgPath,
      scale,
      svgLayout,
    });
    containerLayout = created.report;
    svgLayout = svgLayout ?? created.svgLayout;
  }

  if (!svgLayout) {
    const readResult = await readSvgLayout({
      design,
      wrapperRoot: artifactDir,
    });
    svgLayout = readResult.result;
  }

  const isSingleAutoRoute = isSmallLowComplexityDesign({
    containerLayout,
    ocrBlocks,
    svgNodeCount: svgLayout.nodeCount,
    viewport,
  });

  const createSingleModulePlan = ({
    reason,
    strategy,
    warning,
  }: {
    reason: string;
    strategy: string;
    warning: string;
  }): PlannedModules => ({
    gaps: [],
    ignoredNodeCount: 0,
    modules: [
      createSinglePageModule({
        candidateNodeCount: svgLayout.nodeCount,
        ocrBlocks,
        reason,
        shellManifest,
        viewport,
      }),
    ],
    sharedLayers: [],
    strategy,
    warnings: [warning],
  });

  const shouldAttemptCodex =
    requestedMode !== "single" &&
    requestedPlanner !== "script" &&
    (requestedPlanner === "codex" ||
      (requestedPlanner === "auto" &&
        requestedMode === "auto" &&
        !isSingleAutoRoute));
  let planned: PlannedModules;
  let route: ModulePlanningRoute = "single";
  let plannerMetadata: ModulePlannerMetadata | undefined;

  if (shouldAttemptCodex) {
    const previewImages = await renderCodexPlannerPreviewImages({
      artifactDir,
      design,
    });
    const previewImagePath =
      previewImages[0]?.imagePath ?? path.join(artifactDir, "svg.png");

    const codexResult = await runCodexModulePlanner({
      artifactDir,
      constraints: plannerConstraints,
      containerLayout,
      design: {
        height: design.height,
        name: design.designName,
        previewImagePath,
        previewImages,
        sourceSvgPath: design.svgPath,
        width: design.width,
      },
      mode: requestedMode,
      moduleDir,
      ocrBlocks,
      plannerRetries: safePlannerRetries,
      shellManifest,
      svgLayout,
      viewport,
    });

    if (codexResult.status === "success") {
      planned = codexResult.planned;
      route = "model";
      plannerMetadata = {
        modelAttempted: true,
        requested: requestedPlanner,
        retries: safePlannerRetries,
        selected: "model",
        validation: toValidationSummary(codexResult.validation),
      };
    } else {
      warnings.push(codexResult.failureReason);
      await writeJsonFile(path.join(moduleDir, "planner-failure.json"), {
        attemptCount: codexResult.attemptCount,
        fallback: "single-page",
        reason: codexResult.failureReason,
        requestedPlanner,
        validation: codexResult.validation
          ? toValidationSummary(codexResult.validation)
          : undefined,
      });
      planned = createSingleModulePlan({
        reason:
          "Model planner did not produce a usable plan; keep the whole page as module-01.",
        strategy:
          "Single fallback: one full-page module because model planning failed.",
        warning:
          "Module split fallback used one full-page module after model planner failure.",
      });
      plannerMetadata = {
        fallbackReason: codexResult.failureReason,
        modelAttempted: true,
        requested: requestedPlanner,
        retries: safePlannerRetries,
        selected: "single-page",
        validation: codexResult.validation
          ? toValidationSummary(codexResult.validation)
          : undefined,
      };
    }
  } else {
    const singleReason =
      requestedMode === "single"
        ? "Single mode requested; keep as one full-page module."
        : requestedPlanner === "script"
          ? "Script planner requested; keep as one full-page module."
          : "Single fallback route; keep as one full-page module.";
    planned = createSingleModulePlan({
      reason: singleReason,
      strategy: "Single planner: one full-page module.",
      warning: `Module split skipped; using one full-page module (${viewport.width}x${viewport.height}, svgNodes=${svgLayout.nodeCount}, layoutNodes=${containerLayout.nodeCount}, containers=${containerLayout.containers.length}, ocr=${ocrBlocks.length}).`,
    });
    const fallbackReason =
      requestedPlanner === "script"
        ? "Script planner requested."
        : requestedMode === "single"
          ? "Single mode uses the script planner."
          : undefined;
    plannerMetadata = {
      fallbackReason,
      modelAttempted: false,
      requested: requestedPlanner,
      retries: safePlannerRetries,
      selected: "single-page",
    };
  }

  const sharedLayers = planned.sharedLayers.map((layer) => ({
    ...layer,
    relativePath: `./artifacts/modules/${layer.id}.svg`,
    svgPath: path.join(moduleDir, `${layer.id}.svg`),
  }));

  const buildReport = (): SvgVerticalModuleReport => ({
    design: {
      height: design.height,
      name: design.designName,
      svgPath: design.svgPath,
      width: design.width,
    },
    diffRegions: planned.modules.map((module) => module.diffRegion),
    gaps: planned.gaps,
    ignoredNodeCount: planned.ignoredNodeCount,
    minGap,
    mode: route,
    modules: planned.modules,
    options: {
      minGap,
      planner: requestedPlanner,
      plannerRetries: safePlannerRetries,
      requestedMode,
      targetModuleCount: null,
    },
    planner: plannerMetadata,
    regions: planned.modules.map((module) => module.region),
    sharedLayers,
    sourceStats: {
      containerCount: containerLayout?.containers.length ?? 0,
      ocrBlockCount: ocrBlocks.length,
      shellEntryCount: shellManifest.length,
      svgNodeCount: svgLayout?.nodeCount ?? containerLayout?.nodeCount ?? 0,
    },
    strategy: planned.strategy,
    textLayoutCoordinateSpace: "local",
    warnings: [...warnings, ...(planned.warnings ?? [])],
  });

  const jsonPath = path.join(moduleDir, "module-plan.json");
  const markdownPath = path.join(moduleDir, "module-plan.md");
  const regionsPath = path.join(moduleDir, "module-regions.json");
  const diffRegionsPath = path.join(moduleDir, "module-regions.diff.json");
  const sharedLayersPath = path.join(moduleDir, "shared-layers.json");
  const report = buildReport();
  const quality = await createModulePlanQualityReport({
    artifactDir,
    concurrencyLimit,
    design: {
      height: design.height,
      width: design.width,
    },
    mode: report.mode,
    modules: report.modules,
    ocrBlocks,
    planner: report.planner,
    shellManifest,
    sharedLayers: report.sharedLayers,
  });

  await writeJsonFile(jsonPath, report);
  await writeJsonFile(regionsPath, report.regions);
  await writeJsonFile(diffRegionsPath, report.diffRegions);
  await writeJsonFile(sharedLayersPath, report.sharedLayers);
  await writeTextFile(markdownPath, createMarkdown(report));

  return {
    artifactDir,
    diffRegionsPath,
    jsonPath,
    markdownPath,
    moduleDir,
    qualityJsonPath: quality.jsonPath,
    qualityMarkdownPath: quality.markdownPath,
    qualityReport: quality.report,
    regionsPath,
    report,
  };
};

const createSvgVerticalModuleReport = createAdaptiveModulePlan;

export type {
  CreateAdaptiveModulePlanOptions,
  ModuleGap,
  ModulePlanMode,
  ModulePlanningRoute,
  ModulePlannerMode,
  SvgVerticalModule,
  SvgVerticalModuleArtifacts,
  SvgVerticalModuleReport,
};
export { createAdaptiveModulePlan, createSvgVerticalModuleReport };
