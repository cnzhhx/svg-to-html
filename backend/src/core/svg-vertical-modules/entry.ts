import path from "node:path";
import { readdir, unlink } from "node:fs/promises";

import { createContainerLayoutReport } from "../container-layout/entry.js";
import {
  runModelPlanner,
  toValidationSummary,
} from "../module-planner/model-planner.js";
import { renderModelPlannerPreviewImages } from "../module-planner/preview-images.js";
import type {
  ModulePlannerMetadata,
  ModulePlannerMode,
} from "../module-planner/types.js";
import { createModulePlanQualityReport } from "../module-plan-quality.js";
import { readSvgLayout } from "../svg-layout.js";
import type { Box } from "../geometry.js";
import { resolveArtifactDir } from "../paths.js";
import { resolveSvgDesign } from "../design-resolve.js";
import { writeJsonFile, writeTextFile } from "../file-io.js";
import { createMarkdown } from "./markdown.js";
import { isSmallLowComplexityDesign } from "./route-heuristics.js";
import { createSinglePageModule } from "./single-planner.js";
import type {
  CreateAdaptiveModulePlanOptions,
  ModulePlanMode,
  ModulePlanningRoute,
  PlannedModules,
  SvgVerticalModuleArtifacts,
  SvgVerticalModuleReport,
} from "./types.js";

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
  containerLayoutReport,
  inputPath,
  minGap = 10,
  mode: requestedMode = "auto",
  planner: requestedPlanner = "auto",
  plannerRetries = DEFAULT_PLANNER_RETRIES,
  scale,
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
        reason,
        viewport,
      }),
    ],
    sharedLayers: [],
    strategy,
    warnings: [warning],
  });

  const shouldAttemptModel =
    requestedMode !== "single" &&
    requestedPlanner !== "script" &&
    (requestedPlanner === "model" ||
      (requestedPlanner === "auto" &&
        requestedMode === "auto" &&
        !isSingleAutoRoute));
  let planned: PlannedModules;
  let route: ModulePlanningRoute = "single";
  let plannerMetadata: ModulePlannerMetadata | undefined;

  if (shouldAttemptModel) {
    const previewImages = await renderModelPlannerPreviewImages({
      artifactDir,
      design,
    });
    const previewImagePath =
      previewImages[0]?.imagePath ?? path.join(artifactDir, "svg.png");

    const modelResult = await runModelPlanner({
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
      plannerRetries: safePlannerRetries,
      svgLayout,
      viewport,
    });

    if (modelResult.status === "success") {
      planned = modelResult.planned;
      route = "model";
      plannerMetadata = {
        modelAttempted: true,
        requested: requestedPlanner,
        retries: safePlannerRetries,
        selected: "model",
        validation: toValidationSummary(modelResult.validation),
      };
    } else {
      // First attempt failed — retry the entire planner once more
      warnings.push(
        `[planner-retry] First planner round failed: ${modelResult.failureReason}. Retrying...`,
      );
      await writeJsonFile(path.join(moduleDir, "planner-failure-attempt-1.json"), {
        attemptCount: modelResult.attemptCount,
        reason: modelResult.failureReason,
        requestedPlanner,
        validation: modelResult.validation
          ? toValidationSummary(modelResult.validation)
          : undefined,
      });

      // Clear planner artifacts before second round
      await clearPlannerArtifacts(moduleDir);

      const modelRetryResult = await runModelPlanner({
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
        plannerRetries: safePlannerRetries,
        svgLayout,
        viewport,
      });

      if (modelRetryResult.status === "success") {
        planned = modelRetryResult.planned;
        route = "model";
        plannerMetadata = {
          modelAttempted: true,
          requested: requestedPlanner,
          retries: safePlannerRetries,
          selected: "model",
          validation: toValidationSummary(modelRetryResult.validation),
        };
      } else {
        // Both rounds failed — throw an error instead of falling back to single module
        await writeJsonFile(path.join(moduleDir, "planner-failure.json"), {
          attemptCount:
            modelResult.attemptCount + modelRetryResult.attemptCount,
          reason: modelRetryResult.failureReason,
          requestedPlanner,
          retriedOnce: true,
          validation: modelRetryResult.validation
            ? toValidationSummary(modelRetryResult.validation)
            : undefined,
        });

        throw new Error(
          `Module planner failed after 2 full rounds (${modelResult.attemptCount + modelRetryResult.attemptCount} total attempts). ` +
            `Last failure: ${modelRetryResult.failureReason}`,
        );
      }
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
      warning: `Module split skipped; using one full-page module (${viewport.width}x${viewport.height}, svgNodes=${svgLayout.nodeCount}, layoutNodes=${containerLayout.nodeCount}, containers=${containerLayout.containers.length}).`,
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
      shellEntryCount: 0,
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
    design: {
      height: design.height,
      width: design.width,
    },
    mode: report.mode,
    modules: report.modules,
    planner: report.planner,
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

export type {
  CreateAdaptiveModulePlanOptions,
  ModulePlanMode,
  ModulePlannerMode,
};
export { createAdaptiveModulePlan };
