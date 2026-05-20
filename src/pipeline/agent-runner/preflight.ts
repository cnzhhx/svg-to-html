import path from "node:path";

import { createContainerLayoutReport } from "../../core/container-layout.js";
import { initializeDesignScaffold } from "../../core/design-scaffold.js";
import { buildSemiAutoScaffoldArtifacts } from "../../core/semi-auto-scaffold.js";
import { createAdaptiveModulePlan } from "../../core/svg-vertical-modules.js";
import { cropAllModuleSvgs } from "../../core/svg-vertical-modules/module-svg-crop.js";
import { sessionStore } from "../../session-store.js";
import { archiveSessionCheckpoint } from "./checkpoint.js";

const prepareStructuredSessionInputs = async ({
  artifactDir,
  concurrencyLimit,
  scale,
  sessionId,
  svgPath,
}: {
  artifactDir: string;
  concurrencyLimit: number;
  scale?: number;
  sessionId: string;
  svgPath: string;
}) => {
  sessionStore.addLog(
    sessionId,
    "[pipeline] step 1/6 resolve container-layout",
  );
  sessionStore.startWorkflowNode(sessionId, "analysis", {
    detail: "正在解析 SVG 结构、OCR 和模块信息",
  });

  const containerLayout = await createContainerLayoutReport({
    inputPath: svgPath,
    scale,
  });
  if (containerLayout.visibilityPruning?.prunedNodeCount) {
    sessionStore.addLog(
      sessionId,
      `[pipeline] invisible SVG nodes pruned: ${containerLayout.visibilityPruning.prunedNodeCount}`,
    );
  }

  sessionStore.addLog(
    sessionId,
    "[pipeline] step 2/6 build semi-auto scaffold (OCR + shell assets)",
  );
  const semiAuto = await buildSemiAutoScaffoldArtifacts({
    containerLayoutReport: containerLayout.report,
    inputPath: svgPath,
    scale,
    svgLayoutReport: containerLayout.svgLayout,
  });

  sessionStore.addLog(sessionId, "[pipeline] step 3/6 scaffold initialize");
  const design = await initializeDesignScaffold({
    htmlContent: semiAuto.htmlScaffold,
    inputPath: svgPath,
    scale,
  });

  sessionStore.addLog(sessionId, "[pipeline] step 4/6 plan adaptive modules");
  const modulePlan = await createAdaptiveModulePlan({
    artifactDir,
    concurrencyLimit,
    containerLayoutReport: containerLayout.report,
    inputPath: svgPath,
    minGap: 10,
    ocrBlocks: semiAuto.ocrBlocks,
    scale,
    shellManifest: semiAuto.shellManifest,
    svgLayoutReport: containerLayout.svgLayout,
  });

  sessionStore.addLog(
    sessionId,
    `[pipeline] step 5/6 crop module SVGs (${modulePlan.report.modules.length} module(s))`,
  );
  const moduleSvgCrops = await cropAllModuleSvgs({
    originalSvgPath: containerLayout.visibilityPrunedSvgPath ?? design.svgPath,
    modules: modulePlan.report.modules,
    modulesRootDir: modulePlan.moduleDir,
    scale,
    sharedLayers: modulePlan.report.sharedLayers,
  });

  const shellManifestPath = semiAuto.shellManifestPath;
  const shellManifestEntries = semiAuto.shellManifest;

  // Publish all preflight artifacts before the first agent turn so resumed
  // sessions can skip expensive OCR/layout work and still find every report.
  const current = sessionStore.get(sessionId);
  if (current) {
    sessionStore.update(sessionId, {
      result: {
        ...current.result,
        compareHtmlPath: design.compareHtmlPath,
        containerLayoutPath: containerLayout.markdownPath,
        htmlPath: design.htmlPath,
        shellManifestPath,
        moduleCount: modulePlan.report.modules.length,
        moduleDiffRegionsPath: modulePlan.diffRegionsPath,
        modulePlanMode: modulePlan.report.mode,
        modulePlanMarkdownPath: modulePlan.markdownPath,
        modulePlanPath: modulePlan.jsonPath,
        modulePlanQualityMarkdownPath: modulePlan.qualityMarkdownPath,
        modulePlanQualityPath: modulePlan.qualityJsonPath,
        moduleRegionsPath: modulePlan.regionsPath,
      },
    });
  }

  sessionStore.addLog(
    sessionId,
    `[pipeline] analysis ready: container-recipes=${containerLayout.report.recipes.length}, shell-assets=${shellManifestEntries.length}, ocr-blocks=${semiAuto.ocrBlocks.length}`,
  );
  sessionStore.addLog(
    sessionId,
    `[pipeline] module plan ready: mode=${modulePlan.report.mode}, modules=${modulePlan.report.modules.length}, regions=${path.basename(modulePlan.regionsPath)}`,
  );
  sessionStore.addLog(
    sessionId,
    `[pipeline] module SVGs cropped: ${moduleSvgCrops.size} file(s) under ${path.relative(artifactDir, modulePlan.moduleDir) || "modules"}`,
  );
  sessionStore.addLog(
    sessionId,
    `[pipeline] module plan quality: ${path.basename(modulePlan.qualityJsonPath)}`,
  );
  if (
    !modulePlan.qualityReport.passed ||
    modulePlan.qualityReport.warningIssueCount > 0
  ) {
    sessionStore.addLog(
      sessionId,
      `[pipeline] module plan quality issues: critical=${modulePlan.qualityReport.criticalIssueCount}, warnings=${modulePlan.qualityReport.warningIssueCount}`,
    );
  }
  await archiveSessionCheckpoint({
    sessionId,
    round: 1,
    stage: "analysis",
    note: "Structure analysis artifacts ready",
    metadata: {
      containerRecipeCount: containerLayout.report.recipes.length,
      shellAssetCount: shellManifestEntries.length,
      moduleCount: modulePlan.report.modules.length,
      moduleMode: modulePlan.report.mode,
    },
    materials: [
      {
        kind: "file",
        label: "HTML Scaffold",
        sourcePath: design.htmlPath,
        optional: true,
      },
      {
        kind: "file",
        label: "Container Layout JSON",
        sourcePath: path.join(artifactDir, "container-layout.json"),
        optional: true,
      },
      {
        kind: "file",
        label: "Shell Manifest",
        sourcePath: shellManifestPath,
        optional: true,
      },
      {
        kind: "file",
        label: "Module Plan JSON",
        sourcePath: modulePlan.jsonPath,
        optional: true,
      },
      {
        kind: "file",
        label: "Module Regions",
        sourcePath: modulePlan.regionsPath,
        optional: true,
      },
      {
        kind: "file",
        label: "Module Plan Quality",
        sourcePath: modulePlan.qualityJsonPath,
        optional: true,
      },
      {
        kind: "file",
        label: "Module Plan Quality Markdown",
        sourcePath: modulePlan.qualityMarkdownPath,
        optional: true,
      },
    ],
  });
  sessionStore.completeWorkflowNode(
    sessionId,
    "analysis",
    "结构解析完成，开始进入大模型生成阶段",
  );

  return {
    design,
    staticShells: {
      assetDir: path.dirname(shellManifestPath),
      manifest: shellManifestEntries,
    },
  };
};

export { prepareStructuredSessionInputs };
