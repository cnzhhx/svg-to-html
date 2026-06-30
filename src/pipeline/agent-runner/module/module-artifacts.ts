import { existsSync } from "node:fs";
import path from "node:path";
import {
  copyFile,
  mkdir,
  readFile,
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

const getSourceFragmentPath = (
  moduleDir: string,
  outputFormat: OutputFormat,
) => path.join(moduleDir, getSourceFragmentFileName(outputFormat));

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
  restoreHostModuleArtifacts,
  writeFailedModulePlaceholder,
};
