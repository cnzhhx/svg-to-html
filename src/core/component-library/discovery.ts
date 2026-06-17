import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { isRecord } from "../utils.js";
import type {
  ComponentLibraryComponent,
  ComponentLibraryDescriptor,
  ComponentLibraryFramework,
  ComponentLibraryPackageInfo,
} from "./types.js";

type ComponentLibraryDiscovery = {
  components: ComponentLibraryComponent[];
  packageInfo?: ComponentLibraryPackageInfo;
  publicComponentPaths: string[];
};

type PackageCandidate = {
  info: ComponentLibraryPackageInfo;
  path: string;
  score: number;
};

const DISCOVERY_EXCLUDED_DIRS = new Set([
  ".cache",
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
]);

const ENTRY_FILE_NAMES = [
  "index.ts",
  "index.tsx",
  "index.js",
  "index.jsx",
  "index.mjs",
  "index.cjs",
  "index.vue",
];

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue"];

const normalizePathSeparators = (value: string) => value.replaceAll(path.sep, "/");

const uniqueStrings = (items: Array<string | undefined>) => [
  ...new Set(
    items
      .map((item) => item?.trim())
      .filter((item): item is string => Boolean(item)),
  ),
];

const fileExists = async (filePath: string) => {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
};

const readTextIfExists = async (filePath: string) =>
  readFile(filePath, "utf8").catch(() => "");

const readJsonIfExists = async (filePath: string): Promise<unknown> => {
  const text = await readTextIfExists(filePath);
  if (!text) return undefined;
  return JSON.parse(text) as unknown;
};

const asOptionalString = (value: unknown) => {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
};

const normalizeName = (value: string) =>
  value.replace(/[^A-Za-z0-9]/g, "").toLowerCase();

const toPascalCase = (value: string) => {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  return words
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join("");
};

const isComponentExportName = (value: string) =>
  /^[A-Z][A-Za-z0-9_$]*$/.test(value) &&
  !/^[A-Z0-9_]+$/.test(value) &&
  !/(?:Props|Events|Blocks|Context|State|Status|Options|Config|Constants|TypeDefs|Map|Mode)$/.test(
    value,
  );

const isComponentLikeConstInitializer = (value: string) =>
  /\b(?:functionalWrapper|Component|createVNode|createElement|forwardRef|memo)\b/.test(
    value,
  ) ||
  /^\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(value) ||
  /^\s*[A-Z][A-Za-z0-9_$]*\b(?:\s+as\b|$)/.test(value);

const componentPathKey = (value: string) => normalizePathSeparators(value);

const resolveSourceModule = async (modulePath: string): Promise<string | undefined> => {
  const moduleStat = await stat(modulePath).catch(() => null);
  if (moduleStat?.isFile()) return modulePath;
  if (moduleStat?.isDirectory()) {
    for (const entryName of ENTRY_FILE_NAMES) {
      const candidate = path.join(modulePath, entryName);
      if (await fileExists(candidate)) return candidate;
    }
  }
  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = `${modulePath}${extension}`;
    if (await fileExists(candidate)) return candidate;
  }
  return undefined;
};

const resolveLocalModule = async (fromFile: string, specifier: string) => {
  if (!specifier.startsWith(".")) return undefined;
  return resolveSourceModule(path.resolve(path.dirname(fromFile), specifier));
};

const parseExportSpecifiers = (body: string) =>
  body
    .split(",")
    .flatMap((raw) => {
      const cleaned = raw
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/g, "")
        .trim();
      if (!cleaned) return [];
      const withoutType = cleaned.replace(/^type\s+/, "").trim();
      const parts = withoutType.split(/\s+as\s+/i).map((part) => part.trim());
      return [parts.at(-1) ?? withoutType];
    })
    .filter(isComponentExportName);

const collectExportedValueNames = async (
  modulePath: string,
  visited = new Set<string>(),
): Promise<string[]> => {
  const filePath = await resolveSourceModule(modulePath);
  if (!filePath) return [];
  const normalizedFilePath = path.resolve(filePath);
  if (visited.has(normalizedFilePath)) return [];
  visited.add(normalizedFilePath);

  const text = await readTextIfExists(filePath);
  const names: string[] = [];
  const addMatches = (regex: RegExp) => {
    for (const match of text.matchAll(regex)) {
      const name = match[1];
      if (name && isComponentExportName(name)) names.push(name);
    }
  };

  addMatches(/\bexport\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g);
  addMatches(/\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g);
  addMatches(/\bexport\s+default\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g);
  addMatches(/\bexport\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g);
  for (const match of text.matchAll(
    /\bexport\s+const\s+([A-Za-z_$][\w$]*)\b(?:[^=;]*?)=\s*([^;]+)/g,
  )) {
    const name = match[1];
    const initializer = match[2] ?? "";
    if (
      name &&
      isComponentExportName(name) &&
      isComponentLikeConstInitializer(initializer)
    ) {
      names.push(name);
    }
  }

  for (const match of text.matchAll(/\bexport\s*{([^}]+)}(?:\s+from\s*["']([^"']+)["'])?/g)) {
    const specifier = match[2];
    if (specifier?.startsWith(".")) {
      const resolved = await resolveLocalModule(filePath, specifier);
      if (resolved) {
        names.push(...(await collectExportedValueNames(resolved, visited)));
        continue;
      }
    }
    names.push(...parseExportSpecifiers(match[1] ?? ""));
  }

  for (const match of text.matchAll(/\bexport\s+\*\s+from\s*["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (!specifier) continue;
    const resolved = await resolveLocalModule(filePath, specifier);
    if (resolved) {
      names.push(...(await collectExportedValueNames(resolved, visited)));
    }
  }

  return uniqueStrings(names);
};

const normalizePackageInfo = (value: unknown): ComponentLibraryPackageInfo | undefined => {
  if (!isRecord(value)) return undefined;
  const name = asOptionalString(value.name);
  if (!name) return undefined;
  return {
    importMode: "named",
    importPath: name,
    name,
    styleImports: [],
  };
};

const collectPackageJsonPaths = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const paths: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === "package.json") {
      paths.push(absolute);
      continue;
    }
    if (entry.isDirectory() && !DISCOVERY_EXCLUDED_DIRS.has(entry.name)) {
      paths.push(...(await collectPackageJsonPaths(absolute)));
    }
  }
  return paths;
};

const scorePackageCandidate = ({
  framework,
  packagePath,
  sourceDir,
  value,
}: {
  framework: ComponentLibraryFramework;
  packagePath: string;
  sourceDir: string;
  value: ComponentLibraryPackageInfo;
}) => {
  const relativePath = normalizePathSeparators(path.relative(sourceDir, packagePath));
  const haystack = `${value.name} ${relativePath}`.toLowerCase();
  let score = relativePath === "package.json" ? 5 : 0;
  if (haystack.includes(framework)) score += 20;
  if (framework === "vue") {
    if (haystack.includes("vue-next") || haystack.includes("vue3")) score += 20;
    if (haystack.includes("legacy")) score -= 10;
  }
  if (framework === "react" && haystack.includes("react")) score += 20;
  return score;
};

const discoverPackageInfo = async ({
  framework,
  sourceDir,
}: {
  framework: ComponentLibraryFramework;
  sourceDir: string;
}) => {
  const packagePaths = await collectPackageJsonPaths(sourceDir);
  const candidates = await Promise.all(
    packagePaths.map(async (packagePath): Promise<PackageCandidate | undefined> => {
      const info = normalizePackageInfo(await readJsonIfExists(packagePath));
      if (!info) return undefined;
      return {
        info,
        path: packagePath,
        score: scorePackageCandidate({
          framework,
          packagePath,
          sourceDir,
          value: info,
        }),
      };
    }),
  );
  return candidates
    .filter((candidate): candidate is PackageCandidate => Boolean(candidate))
    .sort((left, right) => right.score - left.score)[0]?.info;
};

const parseLocalExportSpecifiers = (text: string) => [
  ...text.matchAll(/\bexport\s+(?:\*|{[^}]+})\s+from\s*["']([^"']+)["']/g),
].flatMap((match) => {
  const specifier = match[1]?.trim();
  return specifier?.startsWith(".") ? [specifier] : [];
});

const componentRootFromPath = ({
  sourceDir,
  targetPath,
}: {
  sourceDir: string;
  targetPath: string;
}) => {
  const relativePath = normalizePathSeparators(path.relative(sourceDir, targetPath));
  const parts = relativePath.split("/");
  const componentsIndex = parts.indexOf("components");
  const componentDirName = parts[componentsIndex + 1];
  if (componentsIndex < 0 || !componentDirName) return undefined;
  if (path.extname(componentDirName)) return undefined;
  return parts.slice(0, componentsIndex + 2).join("/");
};

const collectRootEntryFiles = async (sourceDir: string) => {
  const candidates = [
    ...ENTRY_FILE_NAMES.map((entryName) => path.join(sourceDir, entryName)),
    ...ENTRY_FILE_NAMES.map((entryName) => path.join(sourceDir, "src", entryName)),
  ];
  const existing = await Promise.all(
    candidates.map(async (candidate) => ((await fileExists(candidate)) ? candidate : undefined)),
  );
  return uniqueStrings(existing);
};

const collectPublicComponentPaths = async (sourceDir: string) => {
  const entryFiles = await collectRootEntryFiles(sourceDir);
  const componentPaths: string[] = [];
  for (const entryFile of entryFiles) {
    const text = await readTextIfExists(entryFile);
    for (const specifier of parseLocalExportSpecifiers(text)) {
      const resolved = await resolveLocalModule(entryFile, specifier);
      if (!resolved) continue;
      const componentPath = componentRootFromPath({
        sourceDir,
        targetPath: resolved,
      });
      if (componentPath) componentPaths.push(componentPath);
    }
  }
  return uniqueStrings(componentPaths);
};

const collectComponentDirsFromRoot = async ({
  rootDir,
  sourceDir,
}: {
  rootDir: string;
  sourceDir: string;
}) => {
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const paths = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const absolute = path.join(rootDir, entry.name);
        const hasEntry = ENTRY_FILE_NAMES.some((entryName) =>
          existsSync(path.join(absolute, entryName)),
        );
        return hasEntry
          ? normalizePathSeparators(path.relative(sourceDir, absolute))
          : undefined;
      }),
  );
  return uniqueStrings(paths);
};

const collectLikelyComponentDirs = async ({
  publicComponentPaths,
  sourceDir,
}: {
  publicComponentPaths: string[];
  sourceDir: string;
}) => {
  const componentRoots = uniqueStrings([
    path.join(sourceDir, "components"),
    path.join(sourceDir, "src", "components"),
    ...publicComponentPaths.flatMap((componentPath) => {
      const parts = componentPath.split("/");
      const componentsIndex = parts.indexOf("components");
      return componentsIndex >= 0
        ? [path.join(sourceDir, ...parts.slice(0, componentsIndex + 1))]
        : [];
    }),
  ]);
  const componentPaths = await Promise.all(
    componentRoots.map((rootDir) =>
      collectComponentDirsFromRoot({
        rootDir,
        sourceDir,
      }),
    ),
  );
  return uniqueStrings(componentPaths.flat());
};

const discoverComponentNames = async ({
  componentPath,
  isPublic,
  sourceDir,
}: {
  componentPath: string;
  isPublic: boolean;
  sourceDir: string;
}) => {
  const absolutePath = path.join(sourceDir, componentPath);
  const exportedNames = await collectExportedValueNames(absolutePath);
  const baseName = path.basename(componentPath);
  const normalizedBaseName = normalizeName(baseName);
  const primaryName = exportedNames.find(
    (name) => normalizeName(name) === normalizedBaseName,
  );
  if (isPublic && exportedNames.length > 0) {
    return primaryName
      ? uniqueStrings([
          primaryName,
          ...exportedNames.filter((name) => name !== primaryName),
        ])
      : exportedNames;
  }
  if (primaryName) return [primaryName];
  return [toPascalCase(baseName) || baseName];
};

const createDiscoveredComponent = ({
  componentPath,
  importPath,
  name,
}: {
  componentPath: string;
  importPath?: string;
  name: string;
}): ComponentLibraryComponent => {
  const pathName = path.basename(componentPath);
  return {
    displayName: toPascalCase(pathName) || name,
    importName: name,
    ...(importPath ? { importPath } : {}),
    keywords: uniqueStrings([name, pathName, toPascalCase(pathName)]),
    name,
    path: componentPath,
    tag: name,
  };
};

const discoverComponentLibrarySource = async ({
  framework,
  sourceDir,
}: {
  framework: ComponentLibraryFramework;
  sourceDir: string;
}): Promise<ComponentLibraryDiscovery> => {
  const packageInfo = await discoverPackageInfo({ framework, sourceDir });
  const publicComponentPaths = await collectPublicComponentPaths(sourceDir);
  const componentPaths = uniqueStrings([
    ...publicComponentPaths,
    ...(await collectLikelyComponentDirs({ publicComponentPaths, sourceDir })),
  ]).sort((left, right) => left.localeCompare(right));
  const publicPathSet = new Set(publicComponentPaths.map(componentPathKey));
  const packageImportPath = packageInfo?.importPath ?? packageInfo?.name;
  const components = (
    await Promise.all(
      componentPaths.map(async (componentPath) => {
        const isPublic = publicPathSet.has(componentPathKey(componentPath));
        const names = await discoverComponentNames({
          componentPath,
          isPublic,
          sourceDir,
        });
        return names.map((name) =>
          createDiscoveredComponent({
            componentPath,
            importPath:
              !isPublic && packageImportPath
                ? `${packageImportPath}/${componentPath}`
                : undefined,
            name,
          }),
        );
      }),
    )
  ).flat();

  const seen = new Set<string>();
  return {
    components: components.filter((component) => {
      const key = component.name;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    packageInfo,
    publicComponentPaths,
  };
};

const findMatchingComponent = ({
  component,
  components,
}: {
  component: ComponentLibraryComponent;
  components: ComponentLibraryComponent[];
}) => {
  const nameCandidates = [component.name, component.importName, component.tag]
    .map((value) => value && normalizeName(value))
    .filter((value): value is string => Boolean(value));
  return (
    components.find(
      (candidate) => {
        const candidateNames = [
          candidate.name,
          candidate.importName,
          candidate.tag,
          candidate.displayName,
        ]
          .map((value) => value && normalizeName(value))
          .filter((value): value is string => Boolean(value));
        return (
          candidate.path === component.path &&
          candidateNames.some((value) => nameCandidates.includes(value))
        );
      },
    ) ??
    components.find((candidate) => normalizeName(candidate.name) === normalizeName(component.name))
  );
};

const mergeComponent = ({
  discovered,
  generated,
}: {
  discovered: ComponentLibraryComponent;
  generated?: ComponentLibraryComponent;
}): ComponentLibraryComponent => ({
  ...generated,
  ...discovered,
  category: generated?.category ?? discovered.category,
  description: generated?.description ?? discovered.description,
  displayName: generated?.displayName ?? discovered.displayName,
  docsPaths: uniqueStrings([...(generated?.docsPaths ?? []), ...(discovered.docsPaths ?? [])]),
  examplePaths: uniqueStrings([
    ...(generated?.examplePaths ?? []),
    ...(discovered.examplePaths ?? []),
  ]),
  importMode: generated?.importMode ?? discovered.importMode,
  keywords: uniqueStrings([...(generated?.keywords ?? []), ...(discovered.keywords ?? [])]),
  styleImports: uniqueStrings([
    ...(generated?.styleImports ?? []),
    ...(discovered.styleImports ?? []),
  ]),
});

const mergeDiscoveredComponentLibraryDescriptor = ({
  descriptor,
  discovery,
}: {
  descriptor: ComponentLibraryDescriptor;
  discovery: ComponentLibraryDiscovery;
}): ComponentLibraryDescriptor => {
  const discoveredPaths = new Set(discovery.components.map((component) => component.path));
  const discoveredNames = new Set(
    discovery.components.map((component) => normalizeName(component.name)),
  );
  const components = [
    ...discovery.components.map((component) =>
      mergeComponent({
        discovered: component,
        generated: findMatchingComponent({
          component,
          components: descriptor.components,
        }),
      }),
    ),
    ...descriptor.components.filter(
      (component) =>
        !discoveredPaths.has(component.path) &&
        !discoveredNames.has(normalizeName(component.name)),
    ),
  ];
  const packageInfo = discovery.packageInfo ?? descriptor.package;
  return {
    ...descriptor,
    components,
    package: {
      ...descriptor.package,
      ...packageInfo,
      styleImports: uniqueStrings([
        ...(descriptor.package.styleImports ?? []),
        ...(packageInfo.styleImports ?? []),
      ]),
    },
  };
};

export {
  discoverComponentLibrarySource,
  mergeDiscoveredComponentLibraryDescriptor,
};
export type { ComponentLibraryDiscovery };
