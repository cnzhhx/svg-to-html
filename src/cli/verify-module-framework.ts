import path from "node:path";

import { readModulePlan } from "../pipeline/module-merge.js";
import { verifyModuleFrameworkLocal } from "../pipeline/agent-runner/module-framework-local-verify.js";
import type { SvgVerticalModule } from "../core/svg-vertical-modules/types.js";
import {
  normalizePlanModules,
  resolveRequiredPath,
} from "./module-plan-utils.js";

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

const INLINE_PREFIXES = [...VALUE_FLAGS].map((flag) => `${flag}=`);

const parseArgs = (args: string[]) => {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;

    const inlinePrefix = INLINE_PREFIXES.find((prefix) =>
      arg.startsWith(prefix),
    );
    if (inlinePrefix) {
      const value = arg.slice(inlinePrefix.length);
      if (!value)
        throw new Error(`Missing value for ${inlinePrefix.slice(0, -1)}`);
      values.set(inlinePrefix.slice(0, -1), value);
      continue;
    }

    if (VALUE_FLAGS.has(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith("-"))
        throw new Error(`Missing value for ${arg}`);
      values.set(arg, value);
      index += 1;
      continue;
    }
  }
  const formatRaw =
    values.get("--format") ??
    values.get("--output-format") ??
    values.get("--outputFormat");
  if (formatRaw !== "vue" && formatRaw !== "react") {
    throw new Error(
      `--format must be "vue" or "react" (got ${String(formatRaw ?? "(missing)")}); this CLI only verifies framework modules`,
    );
  }
  const outputFormat: "vue" | "react" = formatRaw;
  return {
    moduleDir: values.get("--module-dir") ?? values.get("--moduleDir") ?? ".",
    moduleId: values.get("--module-id") ?? values.get("--moduleId"),
    modulePlanPath:
      values.get("--module-plan") ??
      values.get("--modulePlan") ??
      "../module-plan.json",
    moduleSvgPath:
      values.get("--module-svg") ?? values.get("--moduleSvg") ?? "module.svg",
    outputFormat,
    round: Number(values.get("--round") ?? "0"),
    scale: values.get("--scale") ? Number(values.get("--scale")) : undefined,
    scaffoldHtmlPath:
      values.get("--scaffold") ??
      values.get("--scaffold-html") ??
      values.get("--scaffoldHtml") ??
      "../modules-scaffold.html",
  };
};

/**
 * Framework module verify CLI. Builds a real Vite project (Vue/React) from the
 * module's source fragment + source-data + module.css, renders it, and reports
 * a pixel diffRatio against the module SVG. Intended for agent in-turn use on
 * vue/react sessions so the agent sees whether its framework code actually
 * compiles and renders — unlike `verify-module-design.ts` which only renders
 * the HTML preview fragment.
 *
 * Emits compact JSON on stdout: `{"diffRatio":0.123,"passed":false}` (plus
 * `buildError` when the Vite build fails) so the agent-turn command classifier
 * can parse the result for rollback decisions.
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

  console.log(
    JSON.stringify({
      diffRatio: result.diffRatio,
      passed: result.passed,
      ...(result.buildError ? { buildError: result.buildError } : {}),
    }),
  );
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
