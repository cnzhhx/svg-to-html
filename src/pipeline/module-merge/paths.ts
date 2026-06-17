import path from "node:path";

import { toAbsolutePath } from "../../core/utils.js";
import type { ModuleMergeOptions, ModulePlan } from "./types.js";
import { resolveConfiguredPath } from "./utils.js";

const resolveModulePlanPath = ({
  artifactDir,
  modulePlanPath,
}: ModuleMergeOptions) => {
  if (modulePlanPath) return toAbsolutePath(modulePlanPath);
  if (!artifactDir) {
    throw new Error(
      "module merge requires either artifactDir or modulePlanPath",
    );
  }
  return path.join(toAbsolutePath(artifactDir), "modules", "module-plan.json");
};

const resolveRenderEntryPath = ({
  modulePlan,
  renderEntryPath,
  planDir,
}: {
  modulePlan: ModulePlan;
  renderEntryPath?: string;
  planDir: string;
}) => {
  const configuredPath = renderEntryPath ?? modulePlan.renderEntryPath;

  if (!configuredPath) {
    throw new Error(
      "module merge requires renderEntryPath, or renderEntryPath in module-plan.json",
    );
  }

  return resolveConfiguredPath(configuredPath, planDir);
};

const resolveScaffoldRenderPath = ({
  modulePlan,
  renderEntryPath,
  planDir,
  scaffoldRenderPath,
}: {
  modulePlan: ModulePlan;
  renderEntryPath: string;
  planDir: string;
  scaffoldRenderPath?: string;
}) => {
  const configuredPath = scaffoldRenderPath ?? modulePlan.scaffoldRenderPath;

  return configuredPath
    ? resolveConfiguredPath(configuredPath, planDir)
    : renderEntryPath;
};

export {
  resolveModulePlanPath,
  resolveRenderEntryPath,
  resolveScaffoldRenderPath,
};
