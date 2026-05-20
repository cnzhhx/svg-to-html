import { readFile } from "node:fs/promises";
import path from "node:path";

import { cropAllModuleSvgs } from "../core/svg-vertical-modules/module-svg-crop.js";
import type { SvgVerticalModuleReport } from "../core/svg-vertical-modules/types.js";

const VALUE_FLAGS = new Set(["--module-plan", "--modules-dir", "--scale"]);

const parseFlagValue = (args: string[], flag: string) => {
  const inlineArg = args.find((arg) => arg.startsWith(`${flag}=`));
  if (inlineArg) return inlineArg.slice(flag.length + 1);

  const flagIndex = args.indexOf(flag);
  if (flagIndex >= 0) return args[flagIndex + 1];

  return undefined;
};

const parseInputPath = (args: string[]) =>
  args.find((arg, index) => {
    if (arg.startsWith("-")) return false;
    return !VALUE_FLAGS.has(args[index - 1] ?? "");
  });

const resolvePath = (filePath: string) =>
  path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);

const parseScale = (args: string[]) => {
  const raw = parseFlagValue(args, "--scale");
  if (raw === undefined) return undefined;
  const scale = Number(raw);
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(`Invalid value for --scale: ${raw} (expected a positive number)`);
  }
  return scale;
};

const usage =
  "Usage: pnpm exec tsx src/cli/crop-module-svgs.ts 设计稿.svg路径 --module-plan artifacts/modules/module-plan.json [--modules-dir artifacts/modules] [--scale 1]";

const main = async () => {
  const args = process.argv.slice(2);
  const inputPath = parseInputPath(args);
  const modulePlanPath = parseFlagValue(args, "--module-plan");
  const scale = parseScale(args);

  if (!inputPath || !modulePlanPath) {
    throw new Error(usage);
  }

  const resolvedInputPath = resolvePath(inputPath);
  const resolvedModulePlanPath = resolvePath(modulePlanPath);
  const modulesRootDir = resolvePath(
    parseFlagValue(args, "--modules-dir") ??
      path.dirname(resolvedModulePlanPath),
  );
  const modulePlan = JSON.parse(
    await readFile(resolvedModulePlanPath, "utf8"),
  ) as SvgVerticalModuleReport;

  if (!Array.isArray(modulePlan.modules) || modulePlan.modules.length === 0) {
    throw new Error(`No modules found in ${resolvedModulePlanPath}`);
  }

  const results = await cropAllModuleSvgs({
    modules: modulePlan.modules,
    modulesRootDir,
    originalSvgPath: resolvedInputPath,
    scale,
    sharedLayers: modulePlan.sharedLayers,
  });

  console.log("[module-crop] Module SVGs written:");
  for (const module of modulePlan.modules) {
    const result = results.get(module.id);
    if (!result) continue;
    console.log(
      `- ${module.id}: ${result.moduleSvgPath} (${result.viewBox}, retained=${result.retainedRootChildCount}, pruned=${result.prunedRootChildCount})`,
    );
  }
  for (const layer of modulePlan.sharedLayers ?? []) {
    const result = results.get(layer.id);
    if (!result) continue;
    console.log(
      `- ${layer.id}: ${result.moduleSvgPath} (${result.viewBox}, retained=${result.retainedRootChildCount}, pruned=${result.prunedRootChildCount})`,
    );
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
