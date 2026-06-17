import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type {
  ModuleFragmentManifest,
  ModuleMergeResolvedModule,
  ModulePlan,
  ModulePlanModule,
  ModuleSourceData,
} from "./types.js";
import {
  normalizeSourceFragment,
  rewriteModuleLocalAssetReferences,
} from "./html-render.js";
import { readModuleAllowedAssets } from "../agent-runner/module-semantic.js";
import {
  asString,
  isRecord,
  normalizePathForCompare,
  normalizeRegion,
  parseJsonFile,
  readRequiredText,
  resolveConfiguredPath,
} from "./utils.js";

const readOptionalText = async (filePath: string) => {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
};

const readModulePlan = async (modulePlanPath: string): Promise<ModulePlan> => {
  const parsed = await parseJsonFile<unknown>(modulePlanPath, "module plan");
  if (!isRecord(parsed)) {
    throw new Error(`Module plan must be a JSON object: ${modulePlanPath}`);
  }
  return parsed as ModulePlan;
};

const PRODUCED_ASSET_REF_KEYS = [
  "path",
  "relativePath",
  "htmlRef",
] as const;

const collectGeneratedAssetRefs = (manifest: ModuleFragmentManifest) => {
  const refs: string[] = [];
  // producedAssets 是脚本 finalizeModuleManifest 标准化后的唯一资产字段
  for (const collectionKey of ["producedAssets"] as const) {
    const collection = manifest[collectionKey];
    if (!Array.isArray(collection)) continue;
    for (const item of collection) {
      if (!isRecord(item)) continue;
      for (const refKey of PRODUCED_ASSET_REF_KEYS) {
        const ref = asString(item[refKey]);
        if (ref) refs.push(ref);
      }
    }
  }
  return refs;
};

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

const collectTargetPathIssues = ({
  baseDir,
  moduleId,
  renderEntryPath,
  payload,
  sourceLabel,
}: {
  baseDir: string;
  moduleId: string;
  renderEntryPath: string;
  payload: unknown;
  sourceLabel: string;
}) => {
  // Module agents may echo target paths in auxiliary JSON; flag values that
  // point outside the expected module output before merge-time file writes.
  const renderEntryComparable = normalizePathForCompare(renderEntryPath);
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
            `${sourceLabel}.${childPath} declares render entry as target`,
          );
          return;
        }

        const resolved = resolveConfiguredPath(childValue, baseDir);
        if (normalizePathForCompare(resolved) === renderEntryComparable) {
          issues.push(
            `${sourceLabel}.${childPath} points at render entry HTML`,
          );
        }
      }

      visit(childValue, childPath);
    });
  };

  visit(payload, "");

  return issues.map((issue) => `${moduleId}: ${issue}`);
};

const assertFragmentDoesNotTargetDocument = ({
  content,
  filePath,
  label,
  moduleId,
}: {
  content: string;
  filePath: string;
  label: string;
  moduleId: string;
}) => {
  const forbiddenPatterns = [
    { label: "<!doctype>", pattern: /<!doctype\b/i },
    { label: "<html>", pattern: /<html\b/i },
    { label: "<head>", pattern: /<head\b/i },
    { label: "<body>", pattern: /<body\b/i },
    { label: "<main>", pattern: /<main\b/i },
  ];

  const match = forbiddenPatterns.find((item) =>
    item.pattern.test(content),
  );
  if (!match) return;

  throw new Error(
    `${moduleId} ${label} must be a partial fragment, not a main document target. Found ${match.label} in ${filePath}`,
  );
};

const decodeHtmlEntities = (value: string) =>
  value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");

const normalizeVisibleTextToken = (value: string) =>
  decodeHtmlEntities(value)
    .replace(/\s+/g, " ")
    .trim();

const collectPreviewVisibleTextTokens = (html: string) => {
  const stripped = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n");
  const tokens = stripped
    .split(/\n+/)
    .map(normalizeVisibleTextToken)
    .filter((token) => token.length >= 2);
  return [...new Set(tokens)].slice(0, 80);
};

const assertSourcePreviewTextConsistency = ({
  moduleId,
  previewFragmentHtml,
  sourceDataRaw,
  sourceFragmentLabel,
  sourceFragmentRaw,
}: {
  moduleId: string;
  previewFragmentHtml: string;
  sourceDataRaw?: string;
  sourceFragmentLabel: string;
  sourceFragmentRaw: string;
}) => {
  const previewTokens = collectPreviewVisibleTextTokens(previewFragmentHtml);
  if (!previewTokens.length) return;
  const searchableSource = normalizeVisibleTextToken(
    `${sourceFragmentRaw}\n${sourceDataRaw ?? ""}`,
  );
  const missing = previewTokens
    .filter((token) => !searchableSource.includes(token))
    .slice(0, 20);
  if (!missing.length) return;
  throw new Error(
    `${moduleId} ${sourceFragmentLabel} is out of sync with preview.fragment.html; missing visible text token(s): ${missing.join(", ")}. Vue/React final HTML is built from source, so keep source fragment/source-data synchronized with the preview fragment.`,
  );
};

const loadResolvedModule = async ({
  modulePlan,
  modulesDir,
  renderEntryPath,
  planDir,
  planEntry,
}: {
  modulePlan: ModulePlan;
  modulesDir: string;
  renderEntryPath: string;
  planDir: string;
  planEntry: ModulePlanModule;
}): Promise<ModuleMergeResolvedModule> => {
  assertValidModuleId(planEntry.id);

  const moduleDir = getModuleDir({ modulesDir, planDir, planEntry });
  const previewFragmentPath = resolveModuleFilePath({
    defaultFileName: "preview.fragment.html",
    moduleDir,
  });
  const moduleCssPath = resolveModuleFilePath({
    defaultFileName: "module.css",
    moduleDir,
  });
  const outputFormat = modulePlan.outputFormat;
  const sourceFragmentPath =
    outputFormat === "vue"
      ? resolveModuleFilePath({
          defaultFileName: "source.fragment.vue.html",
          moduleDir,
        })
      : outputFormat === "react"
        ? resolveModuleFilePath({
            defaultFileName: "source.fragment.jsx",
            moduleDir,
          })
        : undefined;
  const sourceDataPath =
    outputFormat === "vue" || outputFormat === "react"
      ? resolveModuleFilePath({
          defaultFileName: "source-data.json",
          moduleDir,
        })
      : undefined;
  const manifestPath = resolveModuleFilePath({
    defaultFileName: "manifest.json",
    moduleDir,
  });
  let [
    previewFragmentHtml,
    moduleCss,
    sourceFragment,
    sourceDataRaw,
    manifestRaw,
    allowedAssets,
  ] = await Promise.all([
    readRequiredText(
      previewFragmentPath,
      `${planEntry.id} preview.fragment.html`,
    ),
    readRequiredText(moduleCssPath, `${planEntry.id} module.css`),
    sourceFragmentPath
      ? readRequiredText(
          sourceFragmentPath,
          `${planEntry.id} ${path.basename(sourceFragmentPath)}`,
        )
      : Promise.resolve(undefined),
    sourceDataPath ? readOptionalText(sourceDataPath) : Promise.resolve(undefined),
    readRequiredText(manifestPath, `${planEntry.id} manifest.json`),
    readModuleAllowedAssets(moduleDir),
  ]);
  let manifest: ModuleFragmentManifest;
  let sourceData: ModuleSourceData | undefined;
  try {
    manifest = JSON.parse(manifestRaw) as ModuleFragmentManifest;
  } catch (error) {
    throw new Error(
      `Unable to parse ${planEntry.id} manifest.json as JSON: ${manifestPath} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (sourceDataRaw !== undefined) {
    try {
      const parsed = JSON.parse(sourceDataRaw) as unknown;
      if (!isRecord(parsed)) {
        throw new Error("source-data.json must be a JSON object");
      }
      sourceData = parsed as ModuleSourceData;
    } catch (error) {
      throw new Error(
        `Unable to parse ${planEntry.id} source-data.json as JSON: ${sourceDataPath} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  if (!isRecord(manifest)) {
    throw new Error(
      `${planEntry.id} manifest must be a JSON object: ${manifestPath}`,
    );
  }

  const region = planEntry.region
    ? normalizeRegion(planEntry.region, planEntry.id)
    : normalizeRegion(manifest.region, planEntry.id);
  const sourceFragmentLabel = sourceFragmentPath
    ? path.basename(sourceFragmentPath)
    : undefined;
  const sourceFragmentRaw = sourceFragment;
  if (sourceFragmentPath && !sourceFragment?.trim()) {
    throw new Error(
      `${planEntry.id} ${sourceFragmentLabel} must be non-empty for ${outputFormat} output`,
    );
  }
  if (
    sourceFragmentPath &&
    sourceFragment !== undefined &&
    (outputFormat === "vue" || outputFormat === "react")
  ) {
    sourceFragment = normalizeSourceFragment(sourceFragment, outputFormat);
    if (!sourceFragment.trim()) {
      throw new Error(
        `${planEntry.id} ${sourceFragmentLabel} became empty after ${outputFormat} source-fragment normalization`,
      );
    }
  }

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
      renderEntryPath,
      payload: planEntry,
      sourceLabel: "module-plan",
    }),
    ...collectTargetPathIssues({
      baseDir: moduleDir,
      moduleId: planEntry.id,
      renderEntryPath,
      payload: manifest,
      sourceLabel: "manifest",
    }),
  ];

  if (targetIssues.length) {
    throw new Error(
      `Module artifacts must not target the render entry HTML:\n${targetIssues.join("\n")}`,
    );
  }

  assertFragmentDoesNotTargetDocument({
    content: previewFragmentHtml,
    filePath: previewFragmentPath,
    label: "preview.fragment.html",
    moduleId: planEntry.id,
  });
  if (sourceFragmentPath && sourceFragmentRaw !== undefined) {
    assertFragmentDoesNotTargetDocument({
      content: sourceFragmentRaw,
      filePath: sourceFragmentPath,
      label: sourceFragmentLabel!,
      moduleId: planEntry.id,
    });
    assertSourcePreviewTextConsistency({
      moduleId: planEntry.id,
      previewFragmentHtml,
      sourceDataRaw,
      sourceFragmentLabel: sourceFragmentLabel!,
      sourceFragmentRaw,
    });
  }
  const moduleLocalAssetRefs = collectGeneratedAssetRefs(manifest);

  previewFragmentHtml = rewriteModuleLocalAssetReferences({
    allowedAssets,
    content: previewFragmentHtml,
    moduleDir,
    moduleLocalAssetRefs,
    renderEntryPath,
  });
  moduleCss = rewriteModuleLocalAssetReferences({
    allowedAssets,
    content: moduleCss,
    moduleDir,
    moduleLocalAssetRefs,
    renderEntryPath,
  });

  return {
    allowedAssets,
    dir: moduleDir,
    id: planEntry.id,
    manifest,
    manifestPath,
    moduleLocalAssetRefs,
    moduleCss,
    moduleCssPath,
    planEntry,
    previewFragmentHtml,
    previewFragmentPath,
    region,
    sourceFragment,
    sourceFragmentPath,
    sourceData,
    sourceDataPath,
    sourceDataRaw,
  };
};

export {
  assertUniqueModuleIds,
  loadResolvedModule,
  normalizePlanModules,
  readModulePlan,
};
