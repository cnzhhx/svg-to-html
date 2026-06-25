import path from "node:path";

import { createContainerLayoutReport } from "../../../core/container-layout/index.js";
import { initializeDesignScaffolds } from "../../../core/design-scaffold.js";
import type { OutputFormat } from "../../../core/output-target.js";
import { buildSemiAutoScaffoldArtifacts } from "../../../core/semi-auto-scaffold/index.js";
import { createAdaptiveModulePlan } from "../../../core/svg-vertical-modules/index.js";
import { cropAllModuleSvgs } from "../../../core/svg-vertical-modules/module-svg-crop.js";
import { sessionStore } from "../../../session-store.js";
import { archiveSessionCheckpoint } from "../archive/checkpoint.js";
import { throwIfRunAborted } from "./run-control.js";

const prepareStructuredSessionInputs = async ({
  artifactDir,
  controller,
  outputFormat,
  scale,
  sessionId,
  svgPath,
}: {
  artifactDir: string;
  controller: AbortController;
  outputFormat: OutputFormat;
  scale?: number;
  sessionId: string;
  svgPath: string;
}) => {
  sessionStore.addLog(
    sessionId,
    "[pipeline] step 1/6 resolve container-layout",
  );
  sessionStore.startWorkflowNode(sessionId, "analysis", {
    detail: "正在解析 SVG 结构和模块信息",
  });

  throwIfRunAborted(controller);
  const containerLayout = await createContainerLayoutReport({
    inputPath: svgPath,
    scale,
  });
  throwIfRunAborted(controller);

  sessionStore.addLog(
    sessionId,
    "[pipeline] step 2/6 build semi-auto scaffold (shell assets)",
  );
  throwIfRunAborted(controller);
  const semiAuto = await buildSemiAutoScaffoldArtifacts({
    containerLayoutReport: containerLayout.report,
    inputPath: svgPath,
    scale,
    svgLayoutReport: containerLayout.svgLayout,
  });

  throwIfRunAborted(controller);
  sessionStore.addLog(sessionId, "[pipeline] step 3/6 scaffold initialize");
  const design = await initializeDesignScaffolds({
    format: outputFormat,
    inputPath: svgPath,
    renderContent: semiAuto.htmlScaffold,
    scale,
  });

  throwIfRunAborted(controller);
  sessionStore.addLog(sessionId, "[pipeline] step 4/6 plan adaptive modules");
  const modulePlan = await createAdaptiveModulePlan({
    artifactDir,
    containerLayoutReport: containerLayout.report,
    inputPath: svgPath,
    minGap: 10,
    scale,
    svgLayoutReport: containerLayout.svgLayout,
  });

  throwIfRunAborted(controller);
  sessionStore.addLog(
    sessionId,
    `[pipeline] step 5/6 crop module SVGs (${modulePlan.report.modules.length} module(s))`,
  );
  const moduleSvgCrops = await cropAllModuleSvgs({
    originalSvgPath: design.svgPath,
    modules: modulePlan.report.modules,
    modulesRootDir: modulePlan.moduleDir,
    scale,
    sharedLayers: modulePlan.report.sharedLayers,
  });
  throwIfRunAborted(controller);

  // Publish all preflight artifacts before the first agent turn so resumed
  // sessions can skip expensive analysis work and still find every report.
  const current = sessionStore.get(sessionId);
  if (current) {
    sessionStore.update(sessionId, {
      result: {
        ...current.result,
        compareEntryPath: design.outputTarget.compareEntryPath,
        containerLayoutPath: containerLayout.markdownPath,
        designWidth: modulePlan.report.design.width,
        designHeight: modulePlan.report.design.height,
        outputTarget: design.outputTarget,
        renderEntryPath: design.outputTarget.renderEntryPath,
        sourceEntryPath: design.outputTarget.sourceEntryPath,
        sourceStylePath: design.outputTarget.sourceStylePath,
        moduleCount: modulePlan.report.modules.length,
        moduleDiffRegionsPath: modulePlan.diffRegionsPath,
        modulePlanMode: modulePlan.report.mode,
        modulePlanMarkdownPath: modulePlan.markdownPath,
        modulePlanPath: modulePlan.jsonPath,
        modulePlanQualityMarkdownPath: modulePlan.qualityMarkdownPath,
        modulePlanQualityPath: modulePlan.qualityJsonPath,
      },
    });
  }

  sessionStore.addLog(
    sessionId,
    `[pipeline] analysis ready: container-recipes=${containerLayout.report.recipes.length}`,
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
      moduleCount: modulePlan.report.modules.length,
      moduleMode: modulePlan.report.mode,
    },
    materials: [
      {
        kind: "file",
        label: "Render Scaffold",
        sourcePath: design.outputTarget.renderEntryPath,
        optional: true,
      },
      {
        kind: "file",
        label: "Source Entry",
        sourcePath: design.outputTarget.sourceEntryPath,
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
  };
};

export { prepareStructuredSessionInputs };
