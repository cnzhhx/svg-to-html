import { existsSync } from "node:fs";
import path from "node:path";

import type { ModulePlanModule } from "../pipeline/module-merge.js";

const normalizePlanModules = (modules: unknown): ModulePlanModule[] => {
  if (Array.isArray(modules)) return modules as ModulePlanModule[];
  if (modules && typeof modules === "object") {
    return Object.entries(modules).map(([id, value]) => ({
      ...(value && typeof value === "object" ? value : {}),
      id,
    })) as ModulePlanModule[];
  }
  return [];
};

const resolveRequiredPath = (
  filePath: string,
  baseDir: string,
  label: string,
) => {
  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(baseDir, filePath);
  if (!existsSync(resolved)) throw new Error(`${label} not found: ${resolved}`);
  return resolved;
};

export { normalizePlanModules, resolveRequiredPath };
