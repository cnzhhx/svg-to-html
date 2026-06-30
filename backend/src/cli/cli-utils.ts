import { existsSync } from "node:fs";
import path from "node:path";

import type { ModulePlanModule } from "../pipeline/module-merge/index.js";

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

const parseFlagValue = (
  args: string[],
  flag: string,
): string | undefined => {
  const inlineArg = args.find((arg) => arg.startsWith(`${flag}=`));
  if (inlineArg) return inlineArg.slice(flag.length + 1);

  const index = args.indexOf(flag);
  if (index !== -1 && index + 1 < args.length) {
    return args[index + 1];
  }
  return undefined;
};

const parseCliFlags = (
  args: string[],
  valueFlagSet: Set<string>,
): { flags: Map<string, string>; positionals: string[] } => {
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg.startsWith("--")) {
      if (valueFlagSet.has(arg) && index + 1 < args.length) {
        flags.set(arg, args[index + 1] ?? "");
        index += 1;
      } else if (arg.includes("=")) {
        const [key, ...rest] = arg.split("=");
        flags.set(key!, rest.join("="));
      } else {
        flags.set(arg, "true");
      }
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
};

export { normalizePlanModules, parseCliFlags, parseFlagValue, resolveRequiredPath };
