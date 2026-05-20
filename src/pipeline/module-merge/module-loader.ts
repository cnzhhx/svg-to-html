import { readdir } from "node:fs/promises";
import path from "node:path";

import {
  assertModuleOutputPolicy,
  type ModuleOutputAllowedAsset,
} from "../module-output-policy.js";
import type { TextLayoutConfig } from "../../core/text-layout.js";
import type {
  ModuleFragmentManifest,
  ModuleMergeResolvedModule,
  ModulePlan,
  ModulePlanModule,
  ModuleTextLayoutCoordinateSpace,
} from "./types.js";
import { rewriteModuleLocalAssetReferences } from "./html-render.js";
import { normalizeTextLayoutConfig } from "./text-layout.js";
import {
  asString,
  isRecord,
  normalizePathForCompare,
  normalizeRegion,
  parseJsonFile,
  readRequiredText,
  resolveConfiguredPath,
} from "./utils.js";

const readAllowedAssetsIfExists = async (
  filePath: string,
): Promise<ModuleOutputAllowedAsset[]> => {
  try {
    const parsed = await parseJsonFile<unknown>(filePath, "allowed assets");
    if (Array.isArray(parsed))
      return parsed.filter(isRecord) as ModuleOutputAllowedAsset[];
    if (isRecord(parsed) && Array.isArray(parsed.assets)) {
      return parsed.assets.filter(isRecord) as ModuleOutputAllowedAsset[];
    }
    return [];
  } catch {
    return [];
  }
};

const readModulePlan = async (modulePlanPath: string): Promise<ModulePlan> => {
  const parsed = await parseJsonFile<unknown>(modulePlanPath, "module plan");
  if (!isRecord(parsed)) {
    throw new Error(`Module plan must be a JSON object: ${modulePlanPath}`);
  }
  return parsed as ModulePlan;
};

const GENERATED_ASSET_COLLECTION_KEYS = [
  "generatedAssets",
  "producedAssets",
  "localAssets",
  "moduleAssets",
] as const;

const GENERATED_ASSET_REF_KEYS = [
  "path",
  "relativePath",
  "htmlRef",
  "assetPath",
  "svgPath",
  "pngPath",
  "webpPath",
  "jpgPath",
  "jpegPath",
  "avifPath",
] as const;

const collectGeneratedAssetRefs = (manifest: ModuleFragmentManifest) =>
  GENERATED_ASSET_COLLECTION_KEYS.flatMap((collectionKey) => {
    const collection = manifest[collectionKey];
    if (!Array.isArray(collection)) return [];
    return collection.flatMap((item) => {
      if (!isRecord(item)) return [];
      return GENERATED_ASSET_REF_KEYS.flatMap((refKey) => {
        const ref = asString(item[refKey]);
        return ref ? [ref] : [];
      });
    });
  });

const normalizePlanModules = async ({
  modulePlan,
  modulesDir,
}: {
  modulePlan: ModulePlan;
  modulesDir: string;
}): Promise<ModulePlanModule[]> => {
  const rawModules = modulePlan.modules;

  if (Array.isArray(rawModules)) {
    return rawModules.map((module, index) => {
      if (!isRecord(module)) {
        throw new Error(`module-plan.json modules[${index}] must be an object`);
      }
      const id = asString(module.id);
      if (!id) {
        throw new Error(`module-plan.json modules[${index}] is missing id`);
      }
      return { ...module, id } as ModulePlanModule;
    });
  }

  if (isRecord(rawModules)) {
    return Object.entries(rawModules)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, module]) => {
        if (!isRecord(module)) {
          throw new Error(`module-plan.json modules.${id} must be an object`);
        }
        return { ...module, id } as ModulePlanModule;
      });
  }

  const discovered = await readdir(modulesDir, { withFileTypes: true });
  const moduleIds = discovered
    .filter(
      (entry) => entry.isDirectory() && /^module-[\w-]+$/.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  if (!moduleIds.length) {
    throw new Error(
      `module-plan.json does not define modules, and no module-* directories were found in ${modulesDir}`,
    );
  }

  return moduleIds.map((id) => ({ id }));
};

const assertUniqueModuleIds = (modules: ModulePlanModule[]) => {
  const seen = new Set<string>();
  const duplicate = modules.find((module) => {
    if (seen.has(module.id)) return true;
    seen.add(module.id);
    return false;
  });

  if (duplicate)
    throw new Error(`Duplicate module id in module plan: ${duplicate.id}`);
};

const assertValidModuleId = (id: string) => {
  if (/^module-[A-Za-z0-9_-]+$/.test(id)) return;
  throw new Error(
    `Invalid module id "${id}". Module ids must be CSS-safe and start with "module-".`,
  );
};

const resolveModuleFilePath = ({
  defaultFileName,
  moduleDir,
}: {
  defaultFileName: string;
  moduleDir: string;
}) => path.join(moduleDir, defaultFileName);

const getModuleDir = ({
  modulesDir,
  planDir,
  planEntry,
}: {
  modulesDir: string;
  planDir: string;
  planEntry: ModulePlanModule;
}) => {
  const configuredDir =
    asString(planEntry.dir) ??
    asString(planEntry.moduleDir) ??
    asString(planEntry.path);

  return configuredDir
    ? resolveConfiguredPath(configuredDir, planDir)
    : path.join(modulesDir, planEntry.id);
};

const normalizeCoordinateSpace = (
  value: unknown,
): ModuleTextLayoutCoordinateSpace | undefined => {
  if (value === "absolute" || value === "local") return value;
  return undefined;
};

const inferTextLayoutCoordinateSpace = ({
  region,
  textLayout,
}: {
  region: ModuleMergeResolvedModule["region"];
  textLayout: TextLayoutConfig;
}): ModuleTextLayoutCoordinateSpace => {
  // Older module payloads did not declare whether text boxes were local to the
  // module or absolute page coordinates, so infer it from impossible offsets.
  const blocksWithRegion = (textLayout.blocks ?? []).filter(
    (block) => block.region,
  );
  if (!blocksWithRegion.length) return "absolute";
  if (region.x <= 0 && region.y <= 0) return "absolute";

  const localLikeCount = blocksWithRegion.filter((block) => {
    const blockRegion = block.region;
    if (!blockRegion) return false;
    const regionCenterY = blockRegion.y + blockRegion.height / 2;
    const moduleCenterY = region.y + region.height / 2;
    return (
      blockRegion.y < region.y - 1 &&
      regionCenterY >= -4 &&
      regionCenterY <= region.height + 4 &&
      Math.abs(regionCenterY - moduleCenterY) > region.height * 0.35
    );
  }).length;

  return localLikeCount > blocksWithRegion.length / 2 ? "local" : "absolute";
};

const collectTargetPathIssues = ({
  baseDir,
  moduleId,
  outputHtmlPath,
  payload,
  sourceLabel,
}: {
  baseDir: string;
  moduleId: string;
  outputHtmlPath: string;
  payload: unknown;
  sourceLabel: string;
}) => {
  // Module agents may echo target paths in auxiliary JSON; flag values that
  // point outside the expected module output before merge-time file writes.
  const outputComparable = normalizePathForCompare(outputHtmlPath);
  const issues: string[] = [];

  const isTargetPathKey = (key: string) => {
    const normalized = key
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .replaceAll("_", "-")
      .toLowerCase();

    return (
      normalized === "target" ||
      normalized === "targets" ||
      normalized.includes("html-path") ||
      normalized.includes("target-html") ||
      normalized.includes("output-html") ||
      normalized.includes("final-html") ||
      normalized.includes("main-html") ||
      normalized.includes("write-path") ||
      normalized.includes("destination")
    );
  };

  const isFinalHtmlAliasKey = (key: string) => {
    const normalized = key
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .replaceAll("_", "-")
      .toLowerCase();

    return (
      normalized === "target" ||
      normalized === "targets" ||
      normalized.includes("target-html") ||
      normalized.includes("output-html") ||
      normalized.includes("final-html") ||
      normalized.includes("main-html") ||
      normalized.includes("write-path") ||
      normalized.includes("destination")
    );
  };

  const visit = (value: unknown, keyPath: string) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${keyPath}[${index}]`));
      return;
    }

    if (!isRecord(value)) return;

    Object.entries(value).forEach(([key, childValue]) => {
      const childPath = keyPath ? `${keyPath}.${key}` : key;
      if (typeof childValue === "string" && isTargetPathKey(key)) {
        if (
          isFinalHtmlAliasKey(key) &&
          /^(main|main-html|final-html|session-html|html)$/i.test(childValue)
        ) {
          issues.push(
            `${sourceLabel}.${childPath} declares final HTML as target`,
          );
          return;
        }

        const resolved = resolveConfiguredPath(childValue, baseDir);
        if (normalizePathForCompare(resolved) === outputComparable) {
          issues.push(`${sourceLabel}.${childPath} points at final HTML`);
        }
      }

      visit(childValue, childPath);
    });
  };

  visit(payload, "");

  return issues.map((issue) => `${moduleId}: ${issue}`);
};

const assertFragmentDoesNotTargetDocument = ({
  fragmentHtml,
  htmlPath,
  moduleId,
}: {
  fragmentHtml: string;
  htmlPath: string;
  moduleId: string;
}) => {
  const forbiddenPatterns = [
    { label: "<!doctype>", pattern: /<!doctype\b/i },
    { label: "<html>", pattern: /<html\b/i },
    { label: "<head>", pattern: /<head\b/i },
    { label: "<body>", pattern: /<body\b/i },
    { label: "<main>", pattern: /<main\b/i },
    {
      label: "inline text-layout script",
      pattern: /data-text-layout-config/i,
    },
  ];

  const match = forbiddenPatterns.find((item) =>
    item.pattern.test(fragmentHtml),
  );
  if (!match) return;

  throw new Error(
    `${moduleId} fragment must be a partial HTML fragment, not a main document target. Found ${match.label} in ${htmlPath}`,
  );
};

const loadResolvedModule = async ({
  modulePlan,
  modulesDir,
  outputHtmlPath,
  planDir,
  planEntry,
}: {
  modulePlan: ModulePlan;
  modulesDir: string;
  outputHtmlPath: string;
  planDir: string;
  planEntry: ModulePlanModule;
}): Promise<ModuleMergeResolvedModule> => {
  assertValidModuleId(planEntry.id);

  const moduleDir = getModuleDir({ modulesDir, planDir, planEntry });
  const htmlPath = resolveModuleFilePath({
    defaultFileName: "fragment.html",
    moduleDir,
  });
  const cssPath = resolveModuleFilePath({
    defaultFileName: "fragment.css",
    moduleDir,
  });
  const textLayoutPath = resolveModuleFilePath({
    defaultFileName: "text-layout.json",
    moduleDir,
  });
  const manifestPath = resolveModuleFilePath({
    defaultFileName: "manifest.json",
    moduleDir,
  });
  const allowedAssetsPath = resolveModuleFilePath({
    defaultFileName: "allowed-assets.json",
    moduleDir,
  });

  let [fragmentHtml, fragmentCss, textLayoutRaw, manifestRaw, allowedAssets] =
    await Promise.all([
      readRequiredText(htmlPath, `${planEntry.id} fragment.html`),
      readRequiredText(cssPath, `${planEntry.id} fragment.css`),
      readRequiredText(textLayoutPath, `${planEntry.id} text-layout.json`),
      readRequiredText(manifestPath, `${planEntry.id} manifest.json`),
      readAllowedAssetsIfExists(allowedAssetsPath),
    ]);
  let textLayoutJson: unknown;
  let manifest: ModuleFragmentManifest;
  try {
    textLayoutJson = JSON.parse(textLayoutRaw) as unknown;
  } catch (error) {
    throw new Error(
      `Unable to parse ${planEntry.id} text-layout.json as JSON: ${textLayoutPath} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  try {
    manifest = JSON.parse(manifestRaw) as ModuleFragmentManifest;
  } catch (error) {
    throw new Error(
      `Unable to parse ${planEntry.id} manifest.json as JSON: ${manifestPath} (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  if (!isRecord(manifest)) {
    throw new Error(
      `${planEntry.id} manifest must be a JSON object: ${manifestPath}`,
    );
  }

  const region = planEntry.region
    ? normalizeRegion(planEntry.region, planEntry.id)
    : normalizeRegion(manifest.region, planEntry.id);
  const textLayout = normalizeTextLayoutConfig(textLayoutJson);

  const manifestModuleId = manifest.moduleId ?? manifest.id;
  if (manifestModuleId && manifestModuleId !== planEntry.id) {
    throw new Error(
      `${planEntry.id} manifest id mismatch: expected ${planEntry.id}, got ${manifestModuleId}`,
    );
  }

  const targetIssues = [
    ...collectTargetPathIssues({
      baseDir: planDir,
      moduleId: planEntry.id,
      outputHtmlPath,
      payload: planEntry,
      sourceLabel: "module-plan",
    }),
    ...collectTargetPathIssues({
      baseDir: moduleDir,
      moduleId: planEntry.id,
      outputHtmlPath,
      payload: manifest,
      sourceLabel: "manifest",
    }),
  ];

  if (targetIssues.length) {
    throw new Error(
      `Module fragments must not target the final session HTML:\n${targetIssues.join("\n")}`,
    );
  }

  assertFragmentDoesNotTargetDocument({
    fragmentHtml,
    htmlPath,
    moduleId: planEntry.id,
  });
  await assertModuleOutputPolicy(
    {
      fragmentCss,
      fragmentHtml,
      manifest,
      manifestRaw,
      textLayoutRaw,
    },
    {
      allowedAssets,
      design: modulePlan.design,
      htmlPath: outputHtmlPath,
      moduleDir,
      moduleId: planEntry.id,
      moduleRegion: region,
      originalSvgPath: modulePlan.design?.svgPath,
    },
  );

  fragmentHtml = rewriteModuleLocalAssetReferences({
    allowedAssets,
    content: fragmentHtml,
    moduleDir,
    moduleLocalAssetRefs: collectGeneratedAssetRefs(manifest),
    outputHtmlPath,
  });
  fragmentCss = rewriteModuleLocalAssetReferences({
    allowedAssets,
    content: fragmentCss,
    moduleDir,
    moduleLocalAssetRefs: collectGeneratedAssetRefs(manifest),
    outputHtmlPath,
  });

  return {
    cssPath,
    dir: moduleDir,
    fragmentCss,
    fragmentHtml,
    htmlPath,
    id: planEntry.id,
    manifest,
    manifestPath,
    planEntry,
    region,
    textLayout,
    textLayoutCoordinateSpace:
      normalizeCoordinateSpace(planEntry.textLayoutCoordinateSpace) ??
      normalizeCoordinateSpace(modulePlan.textLayoutCoordinateSpace) ??
      normalizeCoordinateSpace(manifest.textLayoutCoordinateSpace) ??
      inferTextLayoutCoordinateSpace({ region, textLayout }),
    textLayoutPath,
  };
};

export {
  assertUniqueModuleIds,
  loadResolvedModule,
  normalizePlanModules,
  readModulePlan,
};
