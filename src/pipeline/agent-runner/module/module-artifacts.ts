import { existsSync } from "node:fs";
import path from "node:path";
import {
  copyFile,
  cp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";

import {
  getSourceFragmentFileName,
  type OutputFormat,
} from "../../../core/output-target.js";
import {
  MODULE_SVG_CROP_VERSION,
  createModuleSvgCropFingerprint,
  cropModuleSvg,
} from "../../../core/svg-vertical-modules/module-svg-crop.js";
import type { SvgVerticalModule } from "../../../core/svg-vertical-modules/types.js";
import type { ResolvedDesignTarget } from "../../../core/design-resolve.js";

type ModuleSnapshot = {
  assetsSnapshotDir?: string;
  manifest: string;
  moduleCss: string;
  moduleSemantic?: string;
  previewFragmentHtml: string;
  sourceData?: string;
  sourceFragment?: string;
  sourceFragmentFileName?: string;
  diffRatio: number;
};

const getSourceFragmentPath = (
  moduleDir: string,
  outputFormat: OutputFormat,
) => path.join(moduleDir, getSourceFragmentFileName(outputFormat));

const readModuleSnapshot = async (
  moduleDir: string,
  diffRatio: number,
  outputFormat: OutputFormat,
): Promise<ModuleSnapshot> => {
  const sourceFragmentPath =
    outputFormat === "html"
      ? undefined
      : getSourceFragmentPath(moduleDir, outputFormat);
  const sourceDataPath =
    outputFormat === "html" ? undefined : path.join(moduleDir, "source-data.json");
  const [
    previewFragmentHtml,
    moduleCss,
    sourceFragment,
    sourceData,
    manifest,
    moduleSemantic,
  ] = await Promise.all([
    readFile(path.join(moduleDir, "preview.fragment.html"), "utf8"),
    readFile(path.join(moduleDir, "module.css"), "utf8"),
    sourceFragmentPath
      ? readFile(sourceFragmentPath, "utf8")
      : Promise.resolve(undefined),
    sourceDataPath
      ? readFile(sourceDataPath, "utf8").catch(() => undefined)
      : Promise.resolve(undefined),
    readFile(path.join(moduleDir, "manifest.json"), "utf8"),
    readFile(path.join(moduleDir, "module-semantic.json"), "utf8").catch(
      () => undefined,
    ),
  ]);

  const assetsDir = path.join(moduleDir, "assets");
  const assetsSnapshotDir = existsSync(assetsDir)
    ? path.join(
        moduleDir,
        ".module-snapshots",
        `assets-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      )
    : undefined;
  if (assetsSnapshotDir) {
    await mkdir(path.dirname(assetsSnapshotDir), { recursive: true });
    await cp(assetsDir, assetsSnapshotDir, { recursive: true });
  }

  return {
    assetsSnapshotDir,
    diffRatio,
    manifest,
    moduleCss,
    moduleSemantic,
    previewFragmentHtml,
    sourceData,
    sourceFragment,
    sourceFragmentFileName: sourceFragmentPath
      ? path.basename(sourceFragmentPath)
      : undefined,
  };
};

const restoreModuleSnapshot = async (
  moduleDir: string,
  snapshot: ModuleSnapshot,
) => {
  const assetsDir = path.join(moduleDir, "assets");
  await Promise.all([
    writeFile(
      path.join(moduleDir, "preview.fragment.html"),
      snapshot.previewFragmentHtml,
      "utf8",
    ),
    writeFile(path.join(moduleDir, "module.css"), snapshot.moduleCss, "utf8"),
    ...(snapshot.moduleSemantic !== undefined
      ? [
          writeFile(
            path.join(moduleDir, "module-semantic.json"),
            snapshot.moduleSemantic,
            "utf8",
          ),
        ]
      : [rm(path.join(moduleDir, "module-semantic.json"), { force: true })]),
    ...(snapshot.sourceFragment !== undefined && snapshot.sourceFragmentFileName
      ? [
          writeFile(
            path.join(moduleDir, snapshot.sourceFragmentFileName),
            snapshot.sourceFragment,
            "utf8",
          ),
        ]
      : []),
    ...(snapshot.sourceData !== undefined
      ? [
          writeFile(
            path.join(moduleDir, "source-data.json"),
            snapshot.sourceData,
            "utf8",
          ),
        ]
      : [rm(path.join(moduleDir, "source-data.json"), { force: true })]),
    writeFile(path.join(moduleDir, "manifest.json"), snapshot.manifest, "utf8"),
  ]);
  await rm(assetsDir, { force: true, recursive: true });
  if (snapshot.assetsSnapshotDir) {
    await cp(snapshot.assetsSnapshotDir, assetsDir, {
      force: true,
      recursive: true,
    });
  }
};

const hasCompleteModuleOutput = (
  moduleDir: string,
  outputFormat: OutputFormat,
) =>
  [
    "preview.fragment.html",
    "module.css",
    "manifest.json",
    ...(outputFormat === "html"
      ? []
      : [getSourceFragmentFileName(outputFormat)]),
  ].every((fileName) => existsSync(path.join(moduleDir, fileName)));

const writeFailedModulePlaceholder = async ({
  error,
  module,
  moduleDir,
  outputFormat,
}: {
  error: string;
  module: SvgVerticalModule;
  moduleDir: string;
  outputFormat: OutputFormat;
}) => {
  if (hasCompleteModuleOutput(moduleDir, outputFormat)) return;
  await mkdir(moduleDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(moduleDir, "preview.fragment.html"), "", "utf8"),
    writeFile(path.join(moduleDir, "module.css"), "", "utf8"),
    ...(outputFormat === "html"
      ? []
      : [
          writeFile(getSourceFragmentPath(moduleDir, outputFormat), "", "utf8"),
        ]),
    writeFile(
      path.join(moduleDir, "manifest.json"),
      JSON.stringify(
        {
          error,
          moduleId: module.id,
          status: "failed",
        },
        null,
        2,
      ),
      "utf8",
    ),
  ]);
};

const getModuleDir = (modulesRootDir: string, module: SvgVerticalModule) =>
  path.join(modulesRootDir, module.id);

const getModuleSvgPath = (modulesRootDir: string, module: SvgVerticalModule) =>
  path.join(getModuleDir(modulesRootDir, module), "module.svg");

const ensureModuleSvg = async ({
  design,
  module,
  modulesRootDir,
}: {
  design: ResolvedDesignTarget;
  module: SvgVerticalModule;
  modulesRootDir: string;
}) => {
  const moduleSvgPath = getModuleSvgPath(modulesRootDir, module);
  const originalSvg = await readFile(design.svgPath, "utf8");
  const expectedVersion = `data-module-crop-version="${MODULE_SVG_CROP_VERSION}"`;
  const expectedFingerprint = `data-module-crop-fingerprint="${createModuleSvgCropFingerprint(
    {
      module,
      originalSvg,
      scale: design.scale,
    },
  )}"`;
  let needsCrop = true;
  if (existsSync(moduleSvgPath)) {
    const currentModuleSvg = await readFile(moduleSvgPath, "utf8");
    needsCrop = ![expectedVersion, expectedFingerprint].every((marker) =>
      currentModuleSvg.includes(marker),
    );
  }
  if (needsCrop) {
    await cropModuleSvg({
      originalSvgPath: design.svgPath,
      originalSvgSource: originalSvg,
      module,
      outputPath: moduleSvgPath,
      scale: design.scale,
    });
  }
  return moduleSvgPath;
};

const ensureScaffoldSnapshot = async ({
  design,
  modulesRootDir,
}: {
  design: ResolvedDesignTarget;
  modulesRootDir: string;
}) => {
  const scaffoldHtmlPath = path.join(modulesRootDir, "modules-scaffold.html");
  if (!existsSync(scaffoldHtmlPath)) {
    await mkdir(modulesRootDir, { recursive: true });
    await copyFile(design.outputTarget.renderEntryPath, scaffoldHtmlPath);
  }
  return scaffoldHtmlPath;
};

const restoreHostModuleArtifacts = async ({
  modules,
  modulesRootDir,
}: {
  modules: SvgVerticalModule[];
  modulesRootDir: string;
}) => {
  await Promise.all(
    modules.map(async (module) => {
      const moduleDir = getModuleDir(modulesRootDir, module);
      await mkdir(moduleDir, { recursive: true });
    }),
  );
};

export {
  ensureModuleSvg,
  ensureScaffoldSnapshot,
  getModuleDir,
  getSourceFragmentPath,
  hasCompleteModuleOutput,
  readModuleSnapshot,
  restoreHostModuleArtifacts,
  restoreModuleSnapshot,
  writeFailedModulePlaceholder,
};
export type { ModuleSnapshot };
