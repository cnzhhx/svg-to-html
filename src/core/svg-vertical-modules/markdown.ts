import type { SvgVerticalModuleReport } from "./types.js";

export const createMarkdown = (report: SvgVerticalModuleReport) => {
  const planner = report.planner;

  return [
    "# Adaptive Module Plan",
    "",
    `- Design: ${report.design.name}`,
    `- Size: ${report.design.width}x${report.design.height}`,
    `- Route: ${report.mode}`,
    planner
      ? `- Planner: ${planner.selected} (requested: ${planner.requested}, modelAttempted: ${planner.modelAttempted})`
      : "- Planner: unknown",
    planner?.fallbackReason ? `- Planner fallback: ${planner.fallbackReason}` : undefined,
    planner?.validation
      ? `- Planner validation: passed=${planner.validation.passed}, errors=${planner.validation.errorCount}, warnings=${planner.validation.warningCount}`
      : undefined,
    `- Strategy: ${report.strategy}`,
    `- Modules: ${report.modules.length}`,
    `- Shared layers: ${report.sharedLayers.length}`,
    `- Regions: ${report.regions.length}`,
    `- Diff regions: ${report.diffRegions.length}`,
    `- Min gap: ${report.minGap}px`,
    report.options.targetModuleCount
      ? `- Target module count: ${report.options.targetModuleCount}`
      : "- Target module count: auto",
    `- Source nodes: ${report.sourceStats.svgNodeCount}`,
    `- Source containers: ${report.sourceStats.containerCount}`,
    `- OCR blocks: ${report.sourceStats.ocrBlockCount}`,
    `- Shell entries: ${report.sourceStats.shellEntryCount}`,
    "",
    "## Modules",
    "",
    ...report.modules.map((module) =>
      [
        `### ${module.id}`,
        `- kind: ${module.kind}`,
        `- region: x=${module.region.x}, y=${module.region.y}, width=${module.region.width}, height=${module.region.height}`,
        `- diffRegion: x=${module.diffRegion.x}, y=${module.diffRegion.y}, width=${module.diffRegion.width}, height=${module.diffRegion.height}`,
        `- score: ${module.score}`,
        `- source containers: ${module.sourceContainerIds.join(", ") || "none"}`,
        `- OCR blocks: ${module.ocrBlockIds.length}`,
        `- reason: ${module.reason}`,
        "",
      ].join("\n"),
    ),
    ...(report.sharedLayers.length
      ? [
          "## Shared Layers",
          "",
          ...report.sharedLayers.map((layer) =>
            [
              `### ${layer.id}`,
              `- kind: ${layer.kind}`,
              `- region: x=${layer.region.x}, y=${layer.region.y}, width=${layer.region.width}, height=${layer.region.height}`,
              `- node paths: ${layer.nodePaths.length}`,
              `- textTreatment: ${layer.textTreatment}`,
              `- reason: ${layer.reason}`,
              "",
            ].join("\n"),
          ),
        ]
      : []),
    ...(report.warnings.length
      ? [
          "## Warnings",
          "",
          ...report.warnings.map((warning) => `- ${warning}`),
          "",
        ]
      : []),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
};
