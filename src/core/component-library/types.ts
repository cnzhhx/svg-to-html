type ComponentLibraryFramework = "vue" | "react";

type ComponentLibraryImportMode = "named" | "default";

type ComponentLibraryPackageInfo = {
  importMode?: ComponentLibraryImportMode;
  importPath?: string;
  name: string;
  styleImports?: string[];
};

type ComponentLibraryComponent = {
  category?: string;
  description?: string;
  displayName?: string;
  docsPaths?: string[];
  examplePaths?: string[];
  importMode?: ComponentLibraryImportMode;
  importName?: string;
  importPath?: string;
  keywords?: string[];
  name: string;
  path: string;
  styleImports?: string[];
  tag?: string;
};

type ComponentLibraryDescriptor = {
  components: ComponentLibraryComponent[];
  framework: ComponentLibraryFramework;
  id: string;
  name: string;
  package: ComponentLibraryPackageInfo;
  schemaVersion: 1;
};

type ComponentLibraryMeta = {
  createdAt: number;
  id: string;
  install?: {
    completedAt?: number;
    error?: string;
    skippedReason?: string;
    status: "completed" | "failed" | "skipped";
  };
  originalSource?: string;
  sourceType: "local" | "url";
  updatedAt: number;
};

type ComponentLibraryRegistryItem = {
  componentCount: number;
  createdAt?: number;
  descriptorPath: string;
  framework: ComponentLibraryFramework;
  id: string;
  importPath?: string;
  install?: ComponentLibraryMeta["install"];
  name: string;
  packageName?: string;
  sourceDir: string;
  updatedAt?: number;
};

type ComponentLibrarySessionRef = {
  descriptorPath: string;
  framework: ComponentLibraryFramework;
  id: string;
  importPath?: string;
  name: string;
  packageName?: string;
  sourceDir: string;
};

type ComponentLibraryBuildContext = {
  importPath?: string;
  packageName?: string;
  sourceDir: string;
};

type ComponentLibraryAgentContext = {
  adoptionPlanPath?: string;
  descriptor: ComponentLibraryDescriptor;
  descriptorPath: string;
  framework: ComponentLibraryFramework;
  id: string;
  markdownPath: string;
  name: string;
  sourceDir: string;
};

export type {
  ComponentLibraryAgentContext,
  ComponentLibraryBuildContext,
  ComponentLibraryComponent,
  ComponentLibraryDescriptor,
  ComponentLibraryFramework,
  ComponentLibraryImportMode,
  ComponentLibraryMeta,
  ComponentLibraryPackageInfo,
  ComponentLibraryRegistryItem,
  ComponentLibrarySessionRef,
};
