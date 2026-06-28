import path from "node:path";

import { readModulePlan } from "../pipeline/module-merge/index.js";
import { verifyModuleFrameworkLocal } from "../pipeline/agent-runner/module/module-framework-local-verify.js";
import type { SvgVerticalModule } from "../core/svg-vertical-modules/types.js";
import {
  measureModuleAlignment,
  writeMeasuredModuleAlignmentDiagnostics,
} from "./diagnose-module-alignment.js";
import {
  normalizePlanModules,
  parseCliFlags,
  resolveRequiredPath,
} from "./cli-utils.js";
import {
  buildVerifyStopLossRecommendation,
  parseVerifyStopLossHistory,
  parseVerifyStopLossTurnStartedAt,
  readVerifyStopLossState,
} from "../pipeline/agent-runner/turn/verify-stop-loss.js";

const VALUE_FLAGS = new Set([
  "--module-dir",
  "--moduleDir",
  "--module-id",
  "--moduleId",
  "--module-plan",
  "--modulePlan",
  "--module-svg",
  "--moduleSvg",
  "--format",
  "--output-format",
  "--outputFormat",
  "--round",
  "--scale",
  "--scaffold",
  "--scaffold-html",
  "--scaffoldHtml",
]);

const parseArgs = (args: string[]) => {
  const { flags } = parseCliFlags(args, VALUE_FLAGS);
  const formatRaw =
    flags.get("--format") ??
    flags.get("--output-format") ??
    flags.get("--outputFormat");
  if (formatRaw !== "vue" && formatRaw !== "react") {
    throw new Error(
      `--format must be "vue" or "react" (got ${String(formatRaw ?? "(missing)")}); this CLI only verifies framework modules`,
    );
  }
  const outputFormat: "vue" | "react" = formatRaw;
  return {
    moduleDir: flags.get("--module-dir") ?? flags.get("--moduleDir") ?? ".",
    moduleId: flags.get("--module-id") ?? flags.get("--moduleId"),
    modulePlanPath:
      flags.get("--module-plan") ??
      flags.get("--modulePlan") ??
      "../module-plan.json",
    moduleSvgPath:
      flags.get("--module-svg") ?? flags.get("--moduleSvg") ?? "module.svg",
    outputFormat,
    round: Number(flags.get("--round") ?? "0"),
    scale: flags.get("--scale") ? Number(flags.get("--scale")) : undefined,
    scaffoldHtmlPath:
      flags.get("--scaffold") ??
      flags.get("--scaffold-html") ??
      flags.get("--scaffoldHtml") ??
      "../modules-scaffold.html",
  };
};

type AlignmentMeasurementResult =
  | {
      measurement: Awaited<ReturnType<typeof measureModuleAlignment>>;
      ok: true;
    }
  | {
      error: unknown;
      ok: false;
    };

const measureModuleAlignmentSafely = (
  input: Parameters<typeof measureModuleAlignment>[0],
): Promise<AlignmentMeasurementResult> =>
  measureModuleAlignment(input)
    .then((measurement) => ({
      measurement,
      ok: true as const,
    }))
    .catch((error) => ({
      error,
      ok: false as const,
    }));

/**
 * Framework module verify CLI. Builds a real Vite project (Vue/React) from the
 * module's source fragment + source-data + module.css, renders it, and reports
 * a pixel diffRatio against the module SVG. Intended for agent in-turn use on
 * vue/react sessions so the agent sees whether its framework code actually
 * compiles and renders — unlike `verify-module-design.ts` which only renders
 * the HTML preview fragment.
 *
 * Emits compact JSON on stdout, including diffRatio/passed and buildError
 * when the Vite build fails, so the agent-turn command classifier can parse
 * the result for rollback decisions.
 */
const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (
    args.scale !== undefined &&
    (!Number.isFinite(args.scale) || args.scale <= 0)
  ) {
    throw new Error(
      `Invalid value for --scale: ${args.scale} (expected a positive number)`,
    );
  }
  const moduleDir = path.resolve(args.moduleDir);
  const moduleId = args.moduleId ?? path.basename(moduleDir);
  const modulePlanPath = resolveRequiredPath(
    args.modulePlanPath,
    moduleDir,
    "module plan",
  );
  const moduleSvgPath = resolveRequiredPath(
    args.moduleSvgPath,
    moduleDir,
    "module SVG",
  );
  const modulePlan = await readModulePlan(modulePlanPath);
  const module = normalizePlanModules(modulePlan.modules).find(
    (candidate) => candidate.id === moduleId,
  );
  if (!module?.region) {
    throw new Error(
      `Module region not found in ${modulePlanPath}: ${moduleId}`,
    );
  }

  let alignmentMeasurement:
    | ReturnType<typeof measureModuleAlignmentSafely>
    | undefined;
  const result = await verifyModuleFrameworkLocal({
    design: {
      height: module.region.height,
      scale: args.scale,
      width: module.region.width,
    },
    module: {
      id: moduleId,
      region: {
        height: module.region.height,
        id: module.region.id ?? moduleId,
        width: module.region.width,
        x: module.region.x,
        y: module.region.y,
      },
    } as SvgVerticalModule,
    moduleDir,
    moduleSvgPath,
    onProgress: () => {},
    onRenderEntryReady: (renderEntryPath) => {
      alignmentMeasurement = measureModuleAlignmentSafely({
        moduleDir,
        moduleId,
        renderEntry: renderEntryPath,
        scale: args.scale,
      });
    },
    outputFormat: args.outputFormat,
    round: Number.isFinite(args.round) ? args.round : 0,
  });

  if (!result) {
    // Framework verify bailed out (no usable format); report as a non-passing
    // run so the agent-turn rollback machinery treats it as no-improvement.
    console.log(
      JSON.stringify({
        diffRatio: 1,
        passed: false,
        skipped: true,
      }),
    );
    return;
  }

  const alignmentDiagnostics =
    result.renderEntryPath && !result.buildError
      ? await (
          alignmentMeasurement ??
          measureModuleAlignmentSafely({
            moduleDir,
            moduleId,
            renderEntry: result.renderEntryPath,
            scale: args.scale,
          })
        )
          .then((measurementResult) => {
            if (!measurementResult.ok) throw measurementResult.error;
            return writeMeasuredModuleAlignmentDiagnostics(measurementResult.measurement, {
              diffRatio: result.diffRatio,
            });
          })
          .then((diagnostics) => diagnostics.summary)
          .catch((error) => ({
            error: error instanceof Error ? error.message : String(error),
          }))
      : undefined;
  const stopLossState = await readVerifyStopLossState(moduleDir);
  const stopLossRecommendation = buildVerifyStopLossRecommendation({
    now: Date.now(),
    samples: [
      ...(stopLossState?.samples ?? []),
      ...parseVerifyStopLossHistory(process.env["AGENT_VERIFY_DIFF_HISTORY"]),
      {
        diffRatio: result.diffRatio,
        round: Number.isFinite(args.round) ? args.round : 0,
      },
    ],
    turnStartedAt:
      stopLossState?.turnStartedAt ??
      parseVerifyStopLossTurnStartedAt(process.env["AGENT_TURN_STARTED_AT"]),
  });

  console.log(
    JSON.stringify({
      ...(alignmentDiagnostics ? { alignmentDiagnostics } : {}),
      artifacts: {
        artifactDir: result.artifactDir,
        ...(result.diffPngPath ? { diffPngPath: result.diffPngPath } : {}),
        ...(result.renderEntryPath
          ? { renderEntryPath: result.renderEntryPath }
          : {}),
        ...(result.renderPngPath ? { renderPngPath: result.renderPngPath } : {}),
        ...(result.svgPngPath ? { svgPngPath: result.svgPngPath } : {}),
      },
      diffRatio: result.diffRatio,
      ...(result.diffPngPath ? { diffPngPath: result.diffPngPath } : {}),
      passed: result.passed,
      ...(result.renderEntryPath ? { renderEntryPath: result.renderEntryPath } : {}),
      ...(result.renderPngPath ? { renderPngPath: result.renderPngPath } : {}),
      ...(result.svgPngPath ? { svgPngPath: result.svgPngPath } : {}),
      ...(result.buildError ? { buildError: result.buildError } : {}),
      ...(stopLossRecommendation ? { stopLossRecommendation } : {}),
    }),
  );
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
