import { readFile } from "node:fs/promises";
import path from "node:path";

import { areaOf, isFiniteBox, type Box } from "../../../core/geometry.js";
import { isRecord } from "../../../core/type-guards.js";
import { writeTextFile } from "../../../core/file-io.js";
import type { SvgVerticalModule } from "../../../core/svg-vertical-modules/types.js";

type SanitizeModuleOutputResult = {
  changed: boolean;
  removedRootBackground: boolean;
  reason?: string;
};

const BACKGROUND_DECLARATION_RE =
  /(^|;)\s*background(?:-[a-z-]+)?\s*:\s*[^;{}]*(?=;|$);?/gi;

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const readBox = (value: unknown): Box | undefined =>
  isFiniteBox(value) ? value : undefined;

const readString = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const readModuleRegion = (document: unknown): Box | undefined => {
  if (!isRecord(document)) return undefined;
  const moduleValue = document.module;
  if (!isRecord(moduleValue)) return undefined;
  return readBox(moduleValue.region) ?? readBox(moduleValue);
};

const removeAttributeSelectors = (selector: string) =>
  selector.replace(/\[[^\]]*\]/g, "");

const removeFunctionalPseudos = (selector: string) =>
  selector.replace(/:(?:is|not|where|has)\([^)]*\)/gi, "");

const selectorTargetsModuleRoot = (selector: string, moduleId: string) => {
  const trimmed = selector.trim();
  if (!trimmed) return false;
  const moduleIdPattern = escapeRegExp(moduleId);
  const dataAttrPattern = new RegExp(
    `\\[\\s*data-module-id\\s*=\\s*(["'])?${moduleIdPattern}\\1\\s*\\]`,
  );
  const classPattern = new RegExp(`\\.${moduleIdPattern}(?![\\w-])`);
  if (!dataAttrPattern.test(trimmed) && !classPattern.test(trimmed)) {
    return false;
  }

  const structuralSelector = removeFunctionalPseudos(
    removeAttributeSelectors(trimmed),
  );
  return !/[>+~\s]/.test(structuralSelector.trim());
};

const selectorListTargetsOnlyModuleRoots = (
  selectorList: string,
  moduleId: string,
) => {
  const selectors = selectorList.split(",").map((selector) => selector.trim());
  return (
    selectors.length > 0 &&
    selectors.every((selector) => selectorTargetsModuleRoot(selector, moduleId))
  );
};

const stripBackgroundDeclarations = (declarations: string) =>
  declarations
    .replace(BACKGROUND_DECLARATION_RE, "$1")
    .replace(/;\s*;/g, ";")
    .replace(/\{\s*;/g, "{")
    .trimEnd();

const sanitizeModuleRootBackgroundCss = ({
  css,
  moduleId,
  shouldStripRootBackground,
}: {
  css: string;
  moduleId: string;
  shouldStripRootBackground: boolean;
}) => {
  if (!shouldStripRootBackground) return css;
  return css.replace(/([^{}]+)\{([^{}]*)\}/g, (match, selector, body) => {
    if (!selectorListTargetsOnlyModuleRoots(selector, moduleId)) return match;
    const nextBody = stripBackgroundDeclarations(body);
    return nextBody === body ? match : `${selector}{${nextBody}}`;
  });
};

const isExportedVisualNode = (node: Record<string, unknown>) => {
  if (!isRecord(node.semantic)) return false;
  if (readString(node.semantic.exportDecision) !== "export") return false;
  if (readString(node.semantic.textHandling) === "dom-text") return false;
  const tag = readString(node.tag)?.toLowerCase();
  return Boolean(tag && !["defs", "g", "svg"].includes(tag));
};

const moduleHasOwnLargeBackground = (document: unknown) => {
  if (!isRecord(document) || !Array.isArray(document.nodes)) return true;
  const region = readModuleRegion(document);
  if (!region) return true;
  const moduleArea = Math.max(1, areaOf(region));

  return document.nodes.some((rawNode) => {
    if (!isRecord(rawNode) || !isExportedVisualNode(rawNode)) return false;
    const box = readBox(rawNode.bbox);
    if (!box) return false;
    const widthRatio = box.width / Math.max(1, region.width);
    const heightRatio = box.height / Math.max(1, region.height);
    const areaRatio = areaOf(box) / moduleArea;
    return (
      (widthRatio >= 0.8 && heightRatio >= 0.25) ||
      (widthRatio >= 0.6 && heightRatio >= 0.45) ||
      areaRatio >= 0.3
    );
  });
};

const sanitizeModuleOutputFiles = async ({
  module,
  moduleDir,
}: {
  module: SvgVerticalModule;
  moduleDir: string;
}): Promise<SanitizeModuleOutputResult> => {
  const semanticPath = path.join(moduleDir, "module-semantic.json");
  const cssPath = path.join(moduleDir, "module.css");
  const [semanticRaw, css] = await Promise.all([
    readFile(semanticPath, "utf8").catch(() => undefined),
    readFile(cssPath, "utf8"),
  ]);
  if (!semanticRaw) {
    return { changed: false, removedRootBackground: false };
  }

  let semanticDocument: unknown;
  try {
    semanticDocument = JSON.parse(semanticRaw) as unknown;
  } catch {
    return { changed: false, removedRootBackground: false };
  }

  const hasOwnLargeBackground = moduleHasOwnLargeBackground(semanticDocument);
  const nextCss = sanitizeModuleRootBackgroundCss({
    css,
    moduleId: module.id,
    shouldStripRootBackground: !hasOwnLargeBackground,
  });

  if (nextCss === css) {
    return { changed: false, removedRootBackground: false };
  }

  await writeTextFile(cssPath, nextCss);
  return {
    changed: true,
    reason: "module semantic has no large exported background node",
    removedRootBackground: true,
  };
};

export {
  moduleHasOwnLargeBackground,
  sanitizeModuleOutputFiles,
  sanitizeModuleRootBackgroundCss,
};
export type { SanitizeModuleOutputResult };
