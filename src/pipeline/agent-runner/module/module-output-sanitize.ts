import { readFile } from "node:fs/promises";
import path from "node:path";

import { areaOf, isFiniteBox, type Box } from "../../../core/geometry.js";
import { isRecord } from "../../../core/type-guards.js";
import { writeTextFile } from "../../../core/file-io.js";
import type { SvgVerticalModule } from "../../../core/svg-vertical-modules/types.js";

type SanitizeModuleOutputResult = {
  changed: boolean;
  normalizedTextNodes?: number;
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

const readRawString = (value: unknown) =>
  typeof value === "string" ? value : undefined;

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

const escapeHtmlText = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const readSemanticTextByNodeId = (document: unknown) => {
  const result = new Map<string, string>();
  if (!isRecord(document) || !Array.isArray(document.textBlocks)) return result;

  for (const rawBlock of document.textBlocks) {
    if (!isRecord(rawBlock)) continue;
    const id = readString(rawBlock.id);
    const text = readRawString(rawBlock.text);
    if (!id || text === undefined) continue;
    result.set(id, text);
  }

  return result;
};

const TEXT_NODE_ELEMENT_RE =
  /(<([a-z][\w:-]*)(?=[^>]*\bdata-node-id\s*=\s*(["'])([^"']+)\3)[^>]*>)([\s\S]*?)(<\/\2>)/gi;

const normalizeTextNodesFromSemantic = ({
  html,
  textByNodeId,
}: {
  html: string;
  textByNodeId: Map<string, string>;
}) => {
  let changed = false;
  let normalizedTextNodes = 0;
  const nextHtml = html.replace(
    TEXT_NODE_ELEMENT_RE,
    (match, openTag: string, _tag: string, _quote: string, nodeId: string, inner: string, closeTag: string) => {
      const semanticText = textByNodeId.get(nodeId);
      if (semanticText === undefined) return match;
      if (/<[a-z][\s\S]*>/i.test(inner)) return match;
      const nextInner = escapeHtmlText(semanticText);
      if (nextInner === inner) return match;
      changed = true;
      normalizedTextNodes += 1;
      return `${openTag}${nextInner}${closeTag}`;
    },
  );

  return { changed, html: nextHtml, normalizedTextNodes };
};

const normalizeTextOutputFiles = async ({
  moduleDir,
  textByNodeId,
}: {
  moduleDir: string;
  textByNodeId: Map<string, string>;
}) => {
  if (!textByNodeId.size) return { changed: false, normalizedTextNodes: 0 };

  const fileNames = ["preview.fragment.html"];
  let changed = false;
  let normalizedTextNodes = 0;

  for (const fileName of fileNames) {
    const filePath = path.join(moduleDir, fileName);
    const raw = await readFile(filePath, "utf8").catch(() => undefined);
    if (raw === undefined) continue;
    const result = normalizeTextNodesFromSemantic({
      html: raw,
      textByNodeId,
    });
    if (!result.changed) continue;
    await writeTextFile(filePath, result.html);
    changed = true;
    normalizedTextNodes += result.normalizedTextNodes;
  }

  return { changed, normalizedTextNodes };
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
  const textNormalizeResult = await normalizeTextOutputFiles({
    moduleDir,
    textByNodeId: readSemanticTextByNodeId(semanticDocument),
  });
  const cssChanged = nextCss !== css;

  if (!cssChanged && !textNormalizeResult.changed) {
    return { changed: false, removedRootBackground: false };
  }

  if (cssChanged) await writeTextFile(cssPath, nextCss);
  const reasons = [
    cssChanged ? "module semantic has no large exported background node" : "",
    textNormalizeResult.changed
      ? `normalized ${textNormalizeResult.normalizedTextNodes} semantic text node(s)`
      : "",
  ].filter(Boolean);
  return {
    changed: true,
    normalizedTextNodes: textNormalizeResult.normalizedTextNodes,
    reason: reasons.join("; "),
    removedRootBackground: cssChanged,
  };
};

export {
  moduleHasOwnLargeBackground,
  sanitizeModuleOutputFiles,
  sanitizeModuleRootBackgroundCss,
};
export type { SanitizeModuleOutputResult };
