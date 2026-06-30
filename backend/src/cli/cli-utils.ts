import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
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

const resolveVerifyRound = async ({
  explicitRound,
  moduleDir,
  prefix = "round",
}: {
  explicitRound?: string;
  moduleDir: string;
  prefix?: string;
}) => {
  const parsedExplicitRound = Number(explicitRound);
  if (explicitRound !== undefined) {
    return {
      autoAssigned: false,
      round: Number.isFinite(parsedExplicitRound) ? parsedExplicitRound : 0,
    };
  }

  const verifyDir = path.join(moduleDir, "verify");
  const entries = await readdir(verifyDir, { withFileTypes: true }).catch(
    () => [],
  );
  const marker = `${prefix}-`;
  const maxRound = entries.reduce((max, entry) => {
    if (!entry.isDirectory() || !entry.name.startsWith(marker)) return max;
    const round = Number(entry.name.slice(marker.length));
    return Number.isInteger(round) && round >= 0 ? Math.max(max, round) : max;
  }, -1);
  return { autoAssigned: true, round: maxRound + 1 };
};

export {
  normalizePlanModules,
  parseCliFlags,
  parseFlagValue,
  resolveRequiredPath,
  resolveVerifyRound,
};
