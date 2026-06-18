import path from "node:path";
import { readdir, stat } from "node:fs/promises";

import { isInsidePath } from '../paths.js';
import { isRecord } from '../type-guards.js';
import type {
  ComponentLibraryComponent,
  ComponentLibraryDescriptor,
  ComponentLibraryFramework,
  ComponentLibraryImportMode,
  ComponentLibraryPackageInfo,
} from "./types.js";

type ValidateDescriptorInput = {
  descriptor: unknown;
  expectedFramework?: ComponentLibraryFramework;
  expectedId?: string;
  sourceDir: string;
};

const asTrimmedString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const asOptionalString = (value: unknown) => {
  const text = asTrimmedString(value);
  return text || undefined;
};

const asStringArray = (value: unknown) =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        const text = asOptionalString(item);
        return text ? [text] : [];
      })
    : undefined;

const normalizeImportMode = (
  value: unknown,
): ComponentLibraryImportMode | undefined =>
  value === "default" || value === "named" ? value : undefined;

const pathExists = async (filePath: string) => {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
};

const normalizePathSeparators = (value: string) => value.replaceAll(path.sep, "/");

const uniqueStrings = (items: Array<string | undefined>) => [
  ...new Set(
    items
      .map((item) => item?.trim())
      .filter((item): item is string => Boolean(item)),
  ),
];

const splitIdentifierTokens = (value: string) =>
  value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);

const inferCategory = (component: ComponentLibraryComponent) =>
  component.category ??
  (splitIdentifierTokens(path.basename(component.path)).join("-") ||
    component.name.toLowerCase());

const resolveExistingRelativeFiles = async ({
  candidates,
  sourceDir,
}: {
  candidates: string[];
  sourceDir: string;
}) => {
  const existing = await Promise.all(
    candidates.map(async (relativePath) => {
      const normalized = relativePath.replaceAll("\\", "/");
      if (
        !normalized ||
        path.isAbsolute(normalized) ||
        normalized.split("/").some((part) => part === "..")
      ) {
        return undefined;
      }
      return (await pathExists(path.resolve(sourceDir, normalized)))
        ? normalized
        : undefined;
    }),
  );
  return uniqueStrings(existing);
};

const collectDemoPaths = async ({
  component,
  sourceDir,
}: {
  component: ComponentLibraryComponent;
  sourceDir: string;
}) => {
  const componentDir = path.resolve(sourceDir, component.path);
  const demoDirs = ["demos", "demo", "examples", "example"];
  const demoPaths = await Promise.all(
    demoDirs.map(async (dirName) => {
      const demoDir = path.join(componentDir, dirName);
      const entries = await readdir(demoDir, { withFileTypes: true }).catch(
        () => [],
      );
      return entries
        .filter(
          (entry) =>
            entry.isFile() &&
            /\.(?:md|mdx|tsx?|jsx?|vue)$/i.test(entry.name),
        )
        .map((entry) =>
          normalizePathSeparators(
            path.relative(sourceDir, path.join(demoDir, entry.name)),
          ),
        )
        .sort();
    }),
  );
  return demoPaths.flat().slice(0, 6);
};

const enrichComponentLibraryDescriptor = async ({
  descriptor,
  sourceDir,
}: {
  descriptor: ComponentLibraryDescriptor;
  sourceDir: string;
}): Promise<ComponentLibraryDescriptor> => {
  const components = await Promise.all(
    descriptor.components.map(async (component) => {
      const docsPaths = await resolveExistingRelativeFiles({
        candidates: [
          ...(component.docsPaths ?? []),
          path.join(component.path, "index.md"),
          path.join(component.path, "index.mdx"),
          path.join(component.path, "README.md"),
          path.join(component.path, "README.mdx"),
          path.join(component.path, "readme.md"),
          path.join(component.path, "readme.mdx"),
        ],
        sourceDir,
      });
      const examplePaths = uniqueStrings([
        ...(component.examplePaths ?? []),
        ...(await collectDemoPaths({ component, sourceDir })),
      ]);
      const category = inferCategory(component);
      const keywords = uniqueStrings([
        ...(component.keywords ?? []),
        component.name,
        component.displayName,
        category,
        ...splitIdentifierTokens(component.name),
        ...splitIdentifierTokens(path.basename(component.path)),
      ]);
      return {
        ...component,
        category,
        displayName: component.displayName ?? component.name,
        docsPaths,
        examplePaths,
        importName: component.importName ?? component.name,
        keywords,
        tag: component.tag ?? component.importName ?? component.name,
      };
    }),
  );
  return {
    ...descriptor,
    components,
  };
};

const parseFramework = (value: unknown): ComponentLibraryFramework | null => {
  const normalized = asTrimmedString(value).toLowerCase();
  return normalized === "vue" || normalized === "react" ? normalized : null;
};

const assertRelativePathInsideSource = async ({
  componentName,
  rawPath,
  sourceDir,
}: {
  componentName: string;
  rawPath: unknown;
  sourceDir: string;
}) => {
  const relativePath = asTrimmedString(rawPath).replaceAll("\\", "/");
  if (!relativePath) {
    throw new Error(`component "${componentName}" is missing path`);
  }
  if (
    path.isAbsolute(relativePath) ||
    relativePath.split("/").some((part) => part === "..")
  ) {
    throw new Error(
      `component "${componentName}" path must be a relative path inside the copied source dir`,
    );
  }
  const resolved = path.resolve(sourceDir, relativePath);
  if (!isInsidePath(sourceDir, resolved)) {
    throw new Error(`component "${componentName}" path escapes source dir`);
  }
  try {
    await stat(resolved);
  } catch {
    throw new Error(
      `component "${componentName}" path does not exist under source dir: ${relativePath}`,
    );
  }
  return relativePath;
};

const normalizeOptionalRelativePathList = async ({
  componentName,
  rawValue,
  sourceDir,
  fieldName,
}: {
  componentName: string;
  fieldName: string;
  rawValue: unknown;
  sourceDir: string;
}) => {
  const items = Array.isArray(rawValue)
    ? rawValue
    : asOptionalString(rawValue)
      ? [rawValue]
      : [];
  const normalized = await Promise.all(
    items.flatMap((item) => {
      const text = asOptionalString(item);
      return text ? [text] : [];
    }).map((item) =>
      assertRelativePathInsideSource({
        componentName: `${componentName}.${fieldName}`,
        rawPath: item,
        sourceDir,
      }),
    ),
  );
  return [...new Set(normalized)];
};

const normalizePackageInfo = (
  value: unknown,
): ComponentLibraryPackageInfo => {
  if (!isRecord(value)) {
    throw new Error("package must be an object");
  }
  const name = asTrimmedString(value.name);
  if (!name) throw new Error("package.name is required");
  return {
    importMode: normalizeImportMode(value.importMode) ?? "named",
    importPath: asOptionalString(value.importPath) ?? name,
    name,
    styleImports: asStringArray(value.styleImports) ?? [],
  };
};

const normalizeComponent = async ({
  component,
  index,
  sourceDir,
}: {
  component: unknown;
  index: number;
  sourceDir: string;
}): Promise<ComponentLibraryComponent> => {
  if (!isRecord(component)) {
    throw new Error(`components[${index}] must be an object`);
  }
  const name = asTrimmedString(component.name);
  if (!name) throw new Error(`components[${index}].name is required`);
  const componentPath = await assertRelativePathInsideSource({
    componentName: name,
    rawPath: component.path,
    sourceDir,
  });
  return {
    category: asOptionalString(component.category),
    description: asOptionalString(component.description),
    displayName: asOptionalString(component.displayName),
    docsPaths: await normalizeOptionalRelativePathList({
      componentName: name,
      fieldName: "docsPaths",
      rawValue: component.docsPaths ?? component.docsPath,
      sourceDir,
    }),
    examplePaths: await normalizeOptionalRelativePathList({
      componentName: name,
      fieldName: "examplePaths",
      rawValue: component.examplePaths ?? component.examplesPath ?? component.examplePath,
      sourceDir,
    }),
    importMode: normalizeImportMode(component.importMode),
    importName: asOptionalString(component.importName),
    importPath: asOptionalString(component.importPath),
    keywords: asStringArray(component.keywords) ?? [],
    name,
    path: componentPath,
    styleImports: asStringArray(component.styleImports) ?? [],
    tag: asOptionalString(component.tag),
  };
};

const validateComponentLibraryDescriptor = async ({
  descriptor,
  expectedFramework,
  expectedId,
  sourceDir,
}: ValidateDescriptorInput): Promise<ComponentLibraryDescriptor> => {
  if (!isRecord(descriptor)) {
    throw new Error("component-library.json must be a JSON object");
  }
  if (descriptor.schemaVersion !== 1) {
    throw new Error("schemaVersion must be 1");
  }
  const id = asTrimmedString(descriptor.id);
  if (!id) throw new Error("id is required");
  if (expectedId && id !== expectedId) {
    throw new Error(`id must be "${expectedId}"`);
  }
  const name = asTrimmedString(descriptor.name);
  if (!name) throw new Error("name is required");
  const framework = parseFramework(descriptor.framework);
  if (!framework) throw new Error("framework must be vue or react");
  if (expectedFramework && framework !== expectedFramework) {
    throw new Error(`framework must be "${expectedFramework}"`);
  }
  const packageInfo = normalizePackageInfo(descriptor.package);
  if (!Array.isArray(descriptor.components)) {
    throw new Error("components must be an array");
  }
  if (!descriptor.components.length) {
    throw new Error("components must include at least one component");
  }
  const components = await Promise.all(
    descriptor.components.map((component, index) =>
      normalizeComponent({ component, index, sourceDir }),
    ),
  );
  const duplicate = components.find(
    (component, index) =>
      components.findIndex((candidate) => candidate.name === component.name) !==
      index,
  );
  if (duplicate) {
    throw new Error(`Duplicate component name: ${duplicate.name}`);
  }
  return {
    components,
    framework,
    id,
    name,
    package: packageInfo,
    schemaVersion: 1,
  };
};

const readJsonFromText = (text: string): unknown => {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("No JSON object found");
  return JSON.parse(candidate.slice(start, end + 1)) as unknown;
};

export {
  enrichComponentLibraryDescriptor,
  readJsonFromText,
  validateComponentLibraryDescriptor,
};
