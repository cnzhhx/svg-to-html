import path from "node:path";

import {
  ensureComponentLibraryDependenciesInstalled,
  loadComponentLibraryDescriptor,
} from "../../core/component-library/index.js";
import { isRecord } from "../../core/utils.js";
import type {
  ComponentLibraryBuildContext,
  ComponentLibraryComponent,
  ComponentLibraryDescriptor,
  ComponentLibraryImportMode,
  ComponentLibrarySessionRef,
} from "../../core/component-library/types.js";
import type {
  ModuleMergeResolvedModule,
  ModulePlan,
} from "./types.js";
import type { OutputFormat } from "../../core/output-target.js";
import { escapeRegExp, unique } from "./utils.js";

type UsedComponentRef = {
  importMode?: "default" | "named";
  importName?: string;
  importPath?: string;
  moduleId: string;
  name?: string;
  tag?: string;
};

type ResolvedComponentImport = {
  from: string;
  importedName: string;
  localName: string;
  mode: ComponentLibraryImportMode;
};

type FrameworkComponentImportPlan = {
  buildContext?: ComponentLibraryBuildContext;
  imports: string[];
  styleImports: string[];
  usedComponents: UsedComponentRef[];
};

type ComponentImportModule = Pick<
  ModuleMergeResolvedModule,
  "id" | "manifest" | "moduleCss" | "sourceFragment"
>;

const JS_IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const asOptionalString = (value: unknown) => {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
};

const normalizeImportMode = (
  value: unknown,
): ComponentLibraryImportMode | undefined =>
  value === "default" || value === "named" ? value : undefined;

const assertJsIdentifier = (value: string, label: string) => {
  if (JS_IDENTIFIER_RE.test(value)) return value;
  throw new Error(`${label} must be a valid JavaScript identifier: ${value}`);
};

const normalizeRelativeImportPath = (fromDir: string, targetPath: string) => {
  let relative = path.relative(fromDir, targetPath).replaceAll(path.sep, "/");
  if (!relative.startsWith(".")) relative = `./${relative}`;
  return relative;
};

const collectManifestUsedComponents = (
  modules: ComponentImportModule[],
): UsedComponentRef[] =>
  modules.flatMap((module) => {
    const usedComponents = Array.isArray(module.manifest.usedComponents)
      ? module.manifest.usedComponents
      : [];
    return usedComponents.flatMap((raw) => {
      if (!isRecord(raw)) return [];
      const name = asOptionalString(raw.name);
      const importName = asOptionalString(raw.importName);
      const tag = asOptionalString(raw.tag);
      if (!name && !importName && !tag) return [];
      return [
        {
          importMode: normalizeImportMode(raw.importMode),
          importName,
          importPath: asOptionalString(raw.importPath),
          moduleId: module.id,
          name,
          tag,
        },
      ];
    });
  });

const componentAliases = (component: ComponentLibraryComponent) =>
  [
    component.tag,
    component.importName,
    component.name,
    component.displayName,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string =>
      typeof value === "string" && /^[A-Z][A-Za-z0-9_$]*$/.test(value),
    );

const collectAutoUsedComponents = ({
  descriptor,
  modules,
}: {
  descriptor: ComponentLibraryDescriptor;
  modules: ComponentImportModule[];
}): UsedComponentRef[] =>
  modules.flatMap((module) => {
    const source = module.sourceFragment ?? "";
    return descriptor.components.flatMap((component) => {
      const tag = componentAliases(component).find((candidate) =>
        sourceContainsComponentTag(source, candidate),
      );
      if (!tag) return [];
      return [
        {
          importMode: component.importMode,
          importName: component.importName ?? component.name,
          moduleId: module.id,
          name: component.name,
          tag,
        },
      ];
    });
  });

const componentRefKey = (used: UsedComponentRef) =>
  [used.moduleId, used.name ?? used.importName ?? used.tag ?? ""].join("\u0000");

const mergeUsedComponents = (
  manifestUsedComponents: UsedComponentRef[],
  autoUsedComponents: UsedComponentRef[],
) => {
  const result: UsedComponentRef[] = [];
  const seen = new Set<string>();
  for (const used of [...manifestUsedComponents, ...autoUsedComponents]) {
    const key = componentRefKey(used);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(used);
  }
  return result;
};

const collectKnownComponentTags = (descriptor: ComponentLibraryDescriptor) =>
  new Set(
    descriptor.components.flatMap((component) =>
      [component.name, component.importName, component.tag]
        .map((value) => value?.trim())
        .filter((value): value is string =>
          typeof value === "string" && /^[A-Z][A-Za-z0-9_$]*$/.test(value),
        ),
    ),
  );

const sourceContainsComponentTag = (source: string, tag: string) =>
  new RegExp(`<${escapeRegExp(tag)}(?:\\s|/|>)`).test(source);

const collectComponentUsageIssues = ({
  descriptor,
  modules,
  usedComponents,
}: {
  descriptor: ComponentLibraryDescriptor;
  modules: ComponentImportModule[];
  usedComponents: UsedComponentRef[];
}) => {
  const knownTags = collectKnownComponentTags(descriptor);
  return modules.flatMap((module) => {
    const issues: string[] = [];
    const source = module.sourceFragment ?? "";
    for (const used of usedComponents.filter((item) => item.moduleId === module.id)) {
      const component = findComponent({ descriptor, used });
      const tag =
        used.tag ??
        component?.tag ??
        used.importName ??
        component?.importName ??
        used.name ??
        component?.name;
      if (tag && !sourceContainsComponentTag(source, tag)) {
        issues.push(
          `${module.id}: manifest.usedComponents declares "${used.name ?? used.importName ?? used.tag}" but source fragment does not contain <${tag}>`,
        );
      }
    }
    for (const tag of knownTags) {
      if (!sourceContainsComponentTag(source, tag)) continue;
      const declared = usedComponents.some(
        (raw) =>
          raw.moduleId === module.id &&
          [raw.name, raw.importName, raw.tag]
            .map((value) => (typeof value === "string" ? value.trim() : ""))
            .includes(tag),
      );
      if (!declared) {
        issues.push(
          `${module.id}: source fragment uses component tag <${tag}> but it could not be resolved from the selected component library`,
        );
      }
    }
    return issues;
  });
};

const findComponent = ({
  descriptor,
  used,
}: {
  descriptor: ComponentLibraryDescriptor;
  used: UsedComponentRef;
}) => {
  const candidates = [used.name, used.importName, used.tag]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return descriptor.components.find((component) =>
    candidates.some(
      (candidate) =>
        component.name === candidate ||
        component.importName === candidate ||
        component.tag === candidate,
    ),
  );
};

const resolveImportFrom = ({
  component,
  descriptor,
  sourceEntryPath,
  sourceDir,
  used,
}: {
  component: ComponentLibraryComponent;
  descriptor: ComponentLibraryDescriptor;
  sourceEntryPath: string;
  sourceDir: string;
  used: UsedComponentRef;
}) =>
  used.importPath ??
  component.importPath ??
  descriptor.package.importPath ??
  descriptor.package.name ??
  normalizeRelativeImportPath(
    path.dirname(sourceEntryPath),
    path.resolve(sourceDir, component.path),
  );

const resolveComponentImport = ({
  component,
  descriptor,
  sourceEntryPath,
  sourceDir,
  used,
}: {
  component: ComponentLibraryComponent;
  descriptor: ComponentLibraryDescriptor;
  sourceEntryPath: string;
  sourceDir: string;
  used: UsedComponentRef;
}): ResolvedComponentImport => {
  const importedName = assertJsIdentifier(
    used.importName ?? component.importName ?? component.name,
    `${used.moduleId} usedComponents importName`,
  );
  const localName = assertJsIdentifier(
    used.tag ?? component.tag ?? importedName,
    `${used.moduleId} usedComponents tag`,
  );
  return {
    from: resolveImportFrom({
      component,
      descriptor,
      sourceEntryPath,
      sourceDir,
      used,
    }),
    importedName,
    localName,
    mode:
      used.importMode ??
      component.importMode ??
      descriptor.package.importMode ??
      "named",
  };
};

const renderImportLines = (imports: ResolvedComponentImport[]) => {
  const namedGroups = new Map<string, ResolvedComponentImport[]>();
  const defaultGroups = new Map<string, ResolvedComponentImport[]>();
  for (const item of imports) {
    const groups = item.mode === "default" ? defaultGroups : namedGroups;
    groups.set(item.from, [...(groups.get(item.from) ?? []), item]);
  }

  const lines: string[] = [];
  for (const [from, group] of [...namedGroups.entries()].sort()) {
    const specs = unique(
      group.map((item) =>
        item.importedName === item.localName
          ? item.importedName
          : `${item.importedName} as ${item.localName}`,
      ),
    ).sort();
    lines.push(`import { ${specs.join(", ")} } from ${JSON.stringify(from)};`);
  }
  for (const [from, group] of [...defaultGroups.entries()].sort()) {
    const localNames = unique(group.map((item) => item.localName));
    if (localNames.length > 1) {
      throw new Error(
        `Cannot import multiple default components from ${from}: ${localNames.join(", ")}`,
      );
    }
    lines.push(`import ${localNames[0]} from ${JSON.stringify(from)};`);
  }
  return lines;
};

const collectComponentCssOverrideIssues = ({
  descriptor,
  modules,
  ref,
  usedComponents,
}: {
  descriptor: ComponentLibraryDescriptor;
  modules: ComponentImportModule[];
  ref: ComponentLibrarySessionRef;
  usedComponents: UsedComponentRef[];
}) => {
  const importPaths = [
    descriptor.package.name,
    descriptor.package.importPath,
    ref.packageName,
    ref.importPath,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return modules.flatMap((module) => {
    if (!usedComponents.some((item) => item.moduleId === module.id)) return [];
    const issues: string[] = [];
    if (/(?:^|\n)\s*@import\b/i.test(module.moduleCss)) {
      const importsComponentStyle = importPaths.some((importPath) =>
        new RegExp(
          `@import\\s+(?:url\\()?["'][^"']*${escapeRegExp(importPath)}`,
          "i",
        ).test(module.moduleCss),
      );
      if (importsComponentStyle) {
        issues.push(
          `${module.id}: module.css must not import or replace component-library styles; use component props/config/theme tokens instead`,
        );
      }
    }
    if (/(::v-deep|:deep\s*\(|\/deep\/|>>>|:global\s*\()/i.test(module.moduleCss)) {
      issues.push(
        `${module.id}: module.css appears to deep/global override component internals; use public props, slots, config, theme tokens, CSS variables, or wrapper layout instead`,
      );
    }
    return issues;
  });
};

const loadComponentLibraryForMerge = async ({
  modulePlan,
  outputFormat,
}: {
  modulePlan: ModulePlan;
  outputFormat: OutputFormat;
}): Promise<
  | {
      descriptor: ComponentLibraryDescriptor;
      ref: ComponentLibrarySessionRef;
    }
  | undefined
> => {
  if (outputFormat !== "vue" && outputFormat !== "react") return undefined;
  const ref = modulePlan.componentLibrary;
  if (!ref) return undefined;
  const descriptor = await loadComponentLibraryDescriptor(ref.id);
  if (descriptor.framework !== outputFormat) {
    throw new Error(
      `Component library framework (${descriptor.framework}) does not match outputFormat (${outputFormat})`,
    );
  }
  return { descriptor, ref };
};

const createFrameworkComponentImportPlan = async ({
  componentLibrary,
  modules,
  outputFormat,
  sourceEntryPath,
}: {
  componentLibrary?: Awaited<ReturnType<typeof loadComponentLibraryForMerge>>;
  modules: ComponentImportModule[];
  outputFormat: OutputFormat;
  sourceEntryPath: string;
}): Promise<FrameworkComponentImportPlan> => {
  const usedComponents = collectManifestUsedComponents(modules);
  if (!componentLibrary) {
    if (!usedComponents.length) return { imports: [], styleImports: [], usedComponents };
    throw new Error(
      `Modules declare manifest.usedComponents but no component library is selected: ${usedComponents.map((item) => `${item.moduleId}:${item.name ?? item.importName ?? item.tag}`).join(", ")}`,
    );
  }
  if (outputFormat !== "vue" && outputFormat !== "react") {
    throw new Error("manifest.usedComponents is only supported for vue/react output");
  }
  const { descriptor, ref } = componentLibrary;
  const autoUsedComponents = collectAutoUsedComponents({ descriptor, modules });
  usedComponents.splice(
    0,
    usedComponents.length,
    ...mergeUsedComponents(usedComponents, autoUsedComponents),
  );
  const usageIssues = collectComponentUsageIssues({
    descriptor,
    modules,
    usedComponents,
  });
  if (usageIssues.length) {
    throw new Error(usageIssues.join("\n"));
  }
  if (!usedComponents.length) return { imports: [], styleImports: [], usedComponents };
  const cssOverrideIssues = collectComponentCssOverrideIssues({
    descriptor,
    modules,
    ref,
    usedComponents,
  });
  if (cssOverrideIssues.length) {
    throw new Error(cssOverrideIssues.join("\n"));
  }
  const imports = usedComponents.map((used) => {
    const component = findComponent({ descriptor, used });
    if (!component) {
      throw new Error(
        `${used.moduleId}: manifest.usedComponents references unknown component "${used.name ?? used.importName ?? used.tag}"`,
      );
    }
    return resolveComponentImport({
      component,
      descriptor,
      sourceDir: ref.sourceDir,
      sourceEntryPath,
      used,
    });
  });
  const styleImports = unique([
    ...(descriptor.package.styleImports ?? []),
    ...usedComponents.flatMap((used) => {
      const component = findComponent({ descriptor, used });
      return component?.styleImports ?? [];
    }),
  ]).sort();

  await ensureComponentLibraryDependenciesInstalled(ref.id);

  return {
    buildContext: {
      importPath: descriptor.package.importPath ?? descriptor.package.name,
      packageName: descriptor.package.name,
      sourceDir: ref.sourceDir,
    },
    imports: renderImportLines(imports),
    styleImports,
    usedComponents,
  };
};

export { createFrameworkComponentImportPlan, loadComponentLibraryForMerge };
export type {
  ComponentImportModule,
  FrameworkComponentImportPlan,
};
