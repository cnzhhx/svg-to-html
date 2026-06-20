import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { PNG_RASTER_SCALE_MULTIPLIER } from "../config/index.js";
import { capturePage, evaluatePage, launchEdge } from "../core/cdp.js";
import { readSvgDimensions } from "../core/svg-parse.js";
import {
  nodePathToSelector,
  readModuleSemanticDocument,
  updateModuleSemanticDocument,
  type ModuleSemanticGeneratedAsset,
  type ModuleSemanticNode,
} from "../pipeline/agent-runner/module/module-semantic.js";
import {
  GENERATED_ASSET_NO_ORDINARY_TEXT_TREATMENT,
  createGeneratedAssetManifestEntry,
} from "../pipeline/module-output-contract.js";

type Clip = {
  height: number;
  width: number;
  x: number;
  y: number;
};

type ExportResult =
  | {
      clip: Clip;
      ok: true;
      renderedBox: Clip;
      rootSize: {
        height: number;
        width: number;
      };
      selected: Array<{
        index: number;
        tag: string;
      }>;
    }
  | {
      error: string;
      ok: false;
    };

type ParsedArgs = {
  allowText: boolean;
  assetRole?: string;
  elementIndex?: number;
  help: boolean;
  moduleDir: string;
  moduleSvg: string;
  nodeIds: string[];
  output?: string;
  padding: number;
  registerSemantic: boolean;
  scale: number;
  selector?: string;
  textTreatment?: string;
};

type SelectedSemanticNode = ModuleSemanticNode & {
  inspectIndex: number;
};

const VALUE_FLAGS = new Set([
  "--asset-role",
  "--index",
  "--module-dir",
  "--module-svg",
  "--output",
  "--padding",
  "--scale",
  "--selector",
  "--text-treatment",
]);
const MULTI_VALUE_FLAGS = new Set(["--node-id"]);
const BOOLEAN_FLAGS = new Set(["--allow-text", "--register-semantic"]);
const INLINE_PREFIXES = [
  ...VALUE_FLAGS,
  ...MULTI_VALUE_FLAGS,
  ...BOOLEAN_FLAGS,
].map((flag) => `${flag}=`);
const TEXT_TAGS = new Set(["text", "tspan"]);

const parseArgs = (args: string[]): ParsedArgs => {
  const values = new Map<string, string>();
  const multiValues = new Map<string, string[]>();
  const booleans = new Set<string>();
  let help = false;

  const pushMultiValue = (flag: string, value: string) => {
    const next = multiValues.get(flag) ?? [];
    next.push(value);
    multiValues.set(flag, next);
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    const inlinePrefix = INLINE_PREFIXES.find((prefix) =>
      arg.startsWith(prefix),
    );
    if (inlinePrefix) {
      const flag = inlinePrefix.slice(0, -1);
      const value = arg.slice(inlinePrefix.length);
      if (BOOLEAN_FLAGS.has(flag)) {
        if (value !== "" && value !== "true") {
          throw new Error(`${flag} does not take a value`);
        }
        booleans.add(flag);
      } else if (MULTI_VALUE_FLAGS.has(flag)) {
        pushMultiValue(flag, value);
      } else {
        values.set(flag, value);
      }
      continue;
    }

    if (BOOLEAN_FLAGS.has(arg)) {
      booleans.add(arg);
      continue;
    }

    if (VALUE_FLAGS.has(arg) || MULTI_VALUE_FLAGS.has(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`Missing value for ${arg}`);
      }
      if (MULTI_VALUE_FLAGS.has(arg)) {
        pushMultiValue(arg, value);
      } else {
        values.set(arg, value);
      }
      index += 1;
    }
  }

  const rawNodeIds = multiValues.get("--node-id") ?? [];
  const nodeIds = rawNodeIds
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (nodeIds.length > 10) {
    throw new Error("--node-id supports at most 10 selected nodes");
  }

  const rawIndex = values.get("--index");
  const elementIndex = rawIndex === undefined ? undefined : Number(rawIndex);
  if (
    elementIndex !== undefined &&
    (!Number.isInteger(elementIndex) || elementIndex < 0)
  ) {
    throw new Error("--index must be a non-negative integer");
  }

  const rawPadding = values.get("--padding");
  const padding = rawPadding === undefined ? 0 : Number(rawPadding);
  if (!Number.isFinite(padding) || padding < 0) {
    throw new Error("--padding must be a non-negative number");
  }

  const rawScale = values.get("--scale");
  const scale = rawScale === undefined ? 1 : Number(rawScale);
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(
      `Invalid value for --scale: ${rawScale} (expected a positive number)`,
    );
  }

  const selector = values.get("--selector");
  const selectionModeCount =
    Number(elementIndex !== undefined) +
    Number(Boolean(selector)) +
    Number(nodeIds.length > 0);
  if (!help && selectionModeCount !== 1) {
    throw new Error(
      "Provide exactly one of --index <inspect-index>, --selector <css-selector>, or --node-id <semantic-node-id>",
    );
  }

  const output = values.get("--output");
  if (!help && !output) {
    throw new Error("Missing required --output <assets/name.png>");
  }

  return {
    allowText: booleans.has("--allow-text"),
    assetRole: values.get("--asset-role") ?? undefined,
    elementIndex,
    help,
    moduleDir: values.get("--module-dir") ?? ".",
    moduleSvg: values.get("--module-svg") ?? "module.svg",
    nodeIds,
    output,
    padding,
    registerSemantic: booleans.has("--register-semantic"),
    scale,
    selector,
    textTreatment: values.get("--text-treatment") ?? undefined,
  };
};

const usage = () =>
  [
    "Usage:",
    "  pnpm exec tsx src/cli/export-svg-node-asset.ts --module-dir <module-dir> --index <inspect-index> --output assets/name.png [--padding 0] [--scale 1]",
    "  pnpm exec tsx src/cli/export-svg-node-asset.ts --module-dir <module-dir> --selector '<css-selector>' --output assets/name.png [--padding 0] [--scale 1]",
    "  pnpm exec tsx src/cli/export-svg-node-asset.ts --module-dir <module-dir> --node-id n0001 --node-id n0002 --output assets/name.png [--register-semantic] [--padding 0] [--scale 1]",
    "",
    "Notes:",
    "  - Exports one or more visible SVG nodes from module.svg with a transparent page background.",
    "  - --node-id reads node ids from module-semantic.json and supports at most 10 selected nodes.",
    "  - Selected semantic nodes must not be text nodes and must not contain text descendants.",
    "  - --allow-text bypasses that semantic text validation and is intended for internal probe rendering only.",
    "  - Overlap with text outside the selected nodes is allowed.",
    "  - --node-id exports automatically write/update generatedAssets with readableByAgent=true; --register-semantic makes that requirement explicit.",
    "  - --scale must match the session SVG render scale passed by upload/CLI.",
    `  - PNG output adds a ${PNG_RASTER_SCALE_MULTIPLIER}x raster multiplier on top of layout scale for sharper crops.`,
    "  - The selected nodes are rendered in their original SVG coordinate context while non-selected sibling visuals are hidden.",
  ].join("\n");

const scaleClip = (clip: Clip, scale: number) => ({
  height: Number((clip.height * scale).toFixed(6)),
  width: Number((clip.width * scale).toFixed(6)),
  x: Number((clip.x * scale).toFixed(6)),
  y: Number((clip.y * scale).toFixed(6)),
});

const roundClip = (clip: Clip) => ({
  height: Number(clip.height.toFixed(6)),
  width: Number(clip.width.toFixed(6)),
  x: Number(clip.x.toFixed(6)),
  y: Number(clip.y.toFixed(6)),
});

const normalizeSlashes = (value: string) => value.replaceAll("\\", "/");

const stripXmlPreamble = (svg: string) =>
  svg
    .replace(/^\s*<\?xml[\s\S]*?\?>/i, "")
    .replace(/^\s*<!doctype[\s\S]*?>/i, "");

const readExportViewportDimensions = (svg: string) => {
  const svgOpen = svg.match(/<svg\b([^>]*)>/i);
  const attrs = svgOpen?.[1] ?? "";
  const getAttr = (name: string) => {
    const match = attrs.match(
      new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
    );
    return match?.[1] ?? match?.[2] ?? match?.[3];
  };
  const parseNumber = (value: string | undefined) => {
    const match = value?.match(/-?\d+(?:\.\d+)?/);
    if (!match) return undefined;
    const parsed = Number(match[0]);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const width = parseNumber(getAttr("width"));
  const height = parseNumber(getAttr("height"));
  if (width && height && width > 0 && height > 0) {
    return {
      height: Math.ceil(height),
      width: Math.ceil(width),
    };
  }

  return readSvgDimensions(svg);
};

const jsonForScript = (value: unknown) =>
  JSON.stringify(value).replace(/</g, "\\u003c");

const isModuleLocalPath = (moduleDir: string, filePath: string) => {
  const relative = path.relative(moduleDir, filePath);
  return (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
};

const buildNodeIndexMaps = (nodes: ModuleSemanticNode[]) => ({
  nodeById: new Map(nodes.map((node) => [node.id, node] as const)),
  nodeByIndex: new Map(nodes.map((node) => [node.inspectIndex, node] as const)),
  nodeBySelector: new Map(
    nodes.flatMap((node) => {
      // Prefer the compacted `selector` field; fall back to deriving from
      // nodePath for documents written before compact stripped it.
      const selector = node.selector ?? nodePathToSelector(node.nodePath);
      return selector ? [[selector, node] as const] : [];
    }),
  ),
});

const nodeHasTextEvidence = (node: ModuleSemanticNode) =>
  TEXT_TAGS.has(node.tag) ||
  node.semantic.textHandling === "dom-text" ||
  node.semantic.containsReadableText === true ||
  (typeof node.textContent === "string" && node.textContent.trim().length > 0) ||
  (typeof node.semantic.text === "string" && node.semantic.text.trim().length > 0);

const subtreeContainsText = ({
  node,
  nodeById,
}: {
  node: ModuleSemanticNode;
  nodeById: Map<string, ModuleSemanticNode>;
}) => {
  const queuedIds = [node.id];
  const seen = new Set<string>();
  while (queuedIds.length > 0) {
    const currentId = queuedIds.shift();
    if (!currentId || seen.has(currentId)) continue;
    seen.add(currentId);
    const current = currentId === node.id ? node : nodeById.get(currentId);
    if (!current) continue;
    if (nodeHasTextEvidence(current)) return true;
    queuedIds.push(...(current.childIds ?? []));
  }
  return false;
};

const resolveSelectedSemanticNodes = ({
  args,
  semanticNodes,
}: {
  args: ParsedArgs;
  semanticNodes: ModuleSemanticNode[];
}) => {
  const { nodeById, nodeByIndex, nodeBySelector } = buildNodeIndexMaps(
    semanticNodes,
  );

  const resolved: SelectedSemanticNode[] = [];
  const pushUniqueNode = (node: ModuleSemanticNode | undefined) => {
    if (!node) return;
    if (resolved.some((entry) => entry.id === node.id)) return;
    resolved.push(node);
  };

  if (args.nodeIds.length > 0) {
    const missingNodeIds = args.nodeIds.filter((nodeId) => !nodeById.has(nodeId));
    if (missingNodeIds.length > 0) {
      throw new Error(
        `Unknown --node-id value(s): ${missingNodeIds.join(", ")}`,
      );
    }
    args.nodeIds.forEach((nodeId) => pushUniqueNode(nodeById.get(nodeId)));
  } else if (args.elementIndex !== undefined) {
    pushUniqueNode(nodeByIndex.get(args.elementIndex));
  } else if (args.selector) {
    pushUniqueNode(nodeBySelector.get(args.selector));
  }

  return {
    nodeById,
    selectedNodes: resolved,
  };
};

const validateSelectedSemanticNodes = ({
  nodeById,
  selectedNodes,
}: {
  nodeById: Map<string, ModuleSemanticNode>;
  selectedNodes: SelectedSemanticNode[];
}) => {
  const failures = selectedNodes.flatMap((node) => {
    if (!node.bbox) {
      return [`${node.id} has no visible bounding box in module-semantic.json`];
    }
    if (subtreeContainsText({ node, nodeById })) {
      return [
        `${node.id} is a text node or contains text descendants, which are not allowed for export`,
      ];
    }
    return [];
  });

  if (failures.length > 0) {
    throw new Error(failures.join("; "));
  }
};

const buildWrapperHtml = ({
  elementIndices,
  padding,
  selector,
  svg,
}: {
  elementIndices: number[];
  padding: number;
  selector?: string;
  svg: string;
}) => `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <style>
      html, body {
        margin: 0;
        padding: 0;
        background: transparent;
      }

      svg {
        display: block;
      }
    </style>
  </head>
  <body>
    ${stripXmlPreamble(svg)}
    <script>
      const exportSpec = ${jsonForScript({ elementIndices, padding, selector })};
      const URL_REFERENCE_RE = /url\\(#([^)]+)\\)|^#([A-Za-z_][\\w:.-]*)$/g;

      const setResult = (result) => {
        window.__EXPORT_RESULT__ = result;
        window.__RENDER_READY__ = true;
      };

      const intersectRects = (outer, inner) => {
        const left = Math.max(outer.left, inner.left);
        const top = Math.max(outer.top, inner.top);
        const right = Math.min(outer.right, inner.right);
        const bottom = Math.min(outer.bottom, inner.bottom);
        if (!(right > left && bottom > top)) return null;
        return {
          left,
          top,
          right,
          bottom,
          width: right - left,
          height: bottom - top,
          x: left,
          y: top,
        };
      };

      const combineRects = (rects) => {
        if (!Array.isArray(rects) || rects.length === 0) return null;
        const left = Math.min(...rects.map((rect) => rect.left));
        const top = Math.min(...rects.map((rect) => rect.top));
        const right = Math.max(...rects.map((rect) => rect.right));
        const bottom = Math.max(...rects.map((rect) => rect.bottom));
        return {
          left,
          top,
          right,
          bottom,
          width: right - left,
          height: bottom - top,
          x: left,
          y: top,
        };
      };

      const SUPPORT_TAGS = new Set(["defs", "desc", "metadata", "style", "title"]);

      const getAllNodes = (root) =>
        root
          ? [
              root,
              ...Array.from(root.querySelectorAll("*")).filter(
                (node) => node instanceof SVGElement,
              ),
            ]
          : [];

      const findElementById = (root, id) => {
        if (!root || !id) return null;
        if (window.CSS && typeof window.CSS.escape === "function") {
          const bySelector = root.querySelector("#" + window.CSS.escape(id));
          if (bySelector instanceof Element) return bySelector;
        }
        return (
          Array.from(root.querySelectorAll("[id]")).find(
            (node) => node instanceof Element && node.id === id,
          ) || null
        );
      };

      const collectReferenceIds = (value) => {
        if (typeof value !== "string" || !value) return [];
        const ids = [];
        URL_REFERENCE_RE.lastIndex = 0;
        let match;
        while ((match = URL_REFERENCE_RE.exec(value))) {
          const id = match[1] || match[2];
          if (id) ids.push(id);
        }
        URL_REFERENCE_RE.lastIndex = 0;
        return ids;
      };

      const collectReferencedResources = (root, seedNodes) => {
        const resources = new Set();
        const queuedIds = new Set();
        const inspectQueue = [...seedNodes];

        const enqueueId = (id) => {
          if (!id || queuedIds.has(id)) return;
          queuedIds.add(id);
          const resource = findElementById(root, id);
          if (!(resource instanceof Element) || resources.has(resource)) return;
          resources.add(resource);
          inspectQueue.push(resource);
        };

        const inspectNode = (node) => {
          if (!(node instanceof Element)) return;
          Array.from(node.attributes).forEach((attribute) => {
            collectReferenceIds(attribute.value).forEach(enqueueId);
          });
        };

        while (inspectQueue.length > 0) {
          const node = inspectQueue.pop();
          if (!(node instanceof Element)) continue;
          inspectNode(node);
          Array.from(node.querySelectorAll("*")).forEach((child) => {
            inspectNode(child);
          });
        }

        return resources;
      };

      const addNodeAndAncestors = (keepNodes, node, root) => {
        let current = node;
        while (current) {
          keepNodes.add(current);
          if (current === root) break;
          current = current.parentElement;
        }
      };

      const addSubtree = (keepNodes, node) => {
        keepNodes.add(node);
        Array.from(node.querySelectorAll("*")).forEach((child) => {
          keepNodes.add(child);
        });
      };

      const buildElementPath = (root, target) => {
        const path = [];
        let current = target;
        while (current && current !== root) {
          const parent = current.parentElement;
          if (!parent) return null;
          path.unshift(Array.prototype.indexOf.call(parent.children, current));
          current = parent;
        }
        return current === root ? path : null;
      };

      const resolveElementPath = (root, path) => {
        let current = root;
        for (const index of path) {
          current = current?.children?.[index];
          if (!current) return null;
        }
        return current;
      };

      const buildIsolatedSvg = (root, targets) => {
        const targetPaths = targets.map((target) => buildElementPath(root, target));
        if (targetPaths.some((entry) => !entry)) {
          return { error: "Failed to resolve one or more target paths" };
        }
        const workingSvg = root.cloneNode(true);
        const isolatedTargets = targetPaths.map((targetPath) =>
          resolveElementPath(workingSvg, targetPath),
        );
        if (isolatedTargets.some((target) => !target)) {
          return { error: "Failed to restore one or more isolated targets" };
        }

        const keepNodes = new Set();
        isolatedTargets.forEach((target) => {
          addNodeAndAncestors(keepNodes, target, workingSvg);
          addSubtree(keepNodes, target);
        });
        collectReferencedResources(workingSvg, isolatedTargets).forEach((resource) => {
          addNodeAndAncestors(keepNodes, resource, workingSvg);
          addSubtree(keepNodes, resource);
        });

        const prune = (node) => {
          for (const child of Array.from(node.children)) {
            if (!(child instanceof Element)) continue;
            const tag = child.tagName.toLowerCase();
            const keep =
              SUPPORT_TAGS.has(tag) ||
              Boolean(child.closest("defs")) ||
              keepNodes.has(child);
            if (!keep) {
              child.remove();
              continue;
            }
            prune(child);
          }
        };

        prune(workingSvg);
        return { svg: workingSvg, targets: isolatedTargets };
      };

      const trimTransparentEdges = async (svg, rect, rootRect) => {
        try {
          const svgRect = svg.getBoundingClientRect();
          svg.setAttribute("width", String(svgRect.width));
          svg.setAttribute("height", String(svgRect.height));
          const svgData = new XMLSerializer().serializeToString(svg);
          const blob = new Blob([svgData], { type: "image/svg+xml;charset=utf-8" });
          const url = URL.createObjectURL(blob);
          const img = new Image();
          await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = url;
          });

          const offsetX = rect.left - rootRect.left;
          const offsetY = rect.top - rootRect.top;
          const rawW = Math.ceil(rect.width);
          const rawH = Math.ceil(rect.height);

          // Limit canvas size to avoid memory issues; scan at reduced resolution
          const maxDim = 2000;
          const scale = Math.min(1, maxDim / Math.max(rawW, rawH));
          const canvasW = Math.ceil(rawW * scale);
          const canvasH = Math.ceil(rawH * scale);

          const canvas = document.createElement("canvas");
          canvas.width = canvasW;
          canvas.height = canvasH;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            URL.revokeObjectURL(url);
            return rect;
          }

          ctx.drawImage(img, offsetX, offsetY, rawW, rawH, 0, 0, canvasW, canvasH);
          URL.revokeObjectURL(url);

          const imageData = ctx.getImageData(0, 0, canvasW, canvasH);
          const data = imageData.data;
          let minX = canvasW;
          let minY = canvasH;
          let maxX = -1;
          let maxY = -1;

          for (let y = 0; y < canvasH; y++) {
            for (let x = 0; x < canvasW; x++) {
              const alpha = data[(y * canvasW + x) * 4 + 3];
              if (alpha > 10) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
              }
            }
          }

          if (maxX < minX || maxY < minY) return rect;

          const invScale = 1 / scale;
          const trimmedLeft = rect.left + minX * invScale;
          const trimmedTop = rect.top + minY * invScale;
          const trimmedRight = rect.left + (maxX + 1) * invScale;
          const trimmedBottom = rect.top + (maxY + 1) * invScale;

          return {
            left: trimmedLeft,
            top: trimmedTop,
            right: trimmedRight,
            bottom: trimmedBottom,
            width: trimmedRight - trimmedLeft,
            height: trimmedBottom - trimmedTop,
            x: trimmedLeft,
            y: trimmedTop,
          };
        } catch (e) {
          return rect;
        }
      };

      const getRenderableRect = (root, target) => {
        const rootRect = root.getBoundingClientRect();
        const liveRect = target.getBoundingClientRect();
        if (liveRect.width > 0 && liveRect.height > 0) {
          return intersectRects(rootRect, liveRect);
        }
        if (typeof target.getBBox !== "function") {
          return null;
        }
        const bbox = target.getBBox();
        if (!bbox.width || !bbox.height) {
          return null;
        }
        const ctm = target.getCTM();
        const rootCTM = root.getScreenCTM();
        let screenX = bbox.x;
        let screenY = bbox.y;
        let screenW = bbox.width;
        let screenH = bbox.height;
        if (ctm && rootCTM) {
          const combined = rootCTM.inverse().multiply(ctm);
          const p1 = root.createSVGPoint();
          const p2 = root.createSVGPoint();
          p1.x = bbox.x;
          p1.y = bbox.y;
          p2.x = bbox.x + bbox.width;
          p2.y = bbox.y + bbox.height;
          const sp1 = p1.matrixTransform(combined);
          const sp2 = p2.matrixTransform(combined);
          screenX = Math.min(sp1.x, sp2.x);
          screenY = Math.min(sp1.y, sp2.y);
          screenW = Math.abs(sp2.x - sp1.x);
          screenH = Math.abs(sp2.y - sp1.y);
        }
        return intersectRects(rootRect, {
          left: screenX + rootRect.left,
          top: screenY + rootRect.top,
          width: screenW,
          height: screenH,
          right: screenX + rootRect.left + screenW,
          bottom: screenY + rootRect.top + screenH,
          x: screenX + rootRect.left,
          y: screenY + rootRect.top,
        });
      };

      window.addEventListener("load", () => {
        requestAnimationFrame(() => {
          requestAnimationFrame(async () => {
            try {
              const svg = document.querySelector("svg");
              if (!svg) {
                setResult({ ok: false, error: "No <svg> root found" });
                return;
              }

              const allNodes = getAllNodes(svg);
              const requestedTargets = exportSpec.selector
                ? [svg.querySelector(exportSpec.selector)]
                : exportSpec.elementIndices.map((index) => allNodes[index]);
              const targets = [];
              const seenPaths = new Set();
              for (const target of requestedTargets) {
                if (!(target instanceof Element)) {
                  setResult({
                    ok: false,
                    error: exportSpec.selector
                      ? "No node matched --selector"
                      : "One or more nodes matched no --index value",
                  });
                  return;
                }
                const targetPath = buildElementPath(svg, target);
                const pathKey = Array.isArray(targetPath)
                  ? targetPath.length > 0
                    ? targetPath.join("/")
                    : "__root__"
                  : "";
                if (!pathKey || seenPaths.has(pathKey)) continue;
                seenPaths.add(pathKey);
                targets.push(target);
              }

              if (targets.length === 0) {
                setResult({ ok: false, error: "No node matched the requested selection" });
                return;
              }

              if (targets.some((target) => target.closest && target.closest("defs"))) {
                setResult({
                  ok: false,
                  error: "Selected node is inside <defs> and is not directly renderable",
                });
                return;
              }

              const isolated = buildIsolatedSvg(svg, targets);
              if (!isolated.svg || !isolated.targets) {
                setResult({
                  ok: false,
                  error: isolated.error ?? "Failed to isolate SVG node selection",
                });
                return;
              }

              svg.replaceWith(isolated.svg);

              const targetRects = isolated.targets.map((target) =>
                getRenderableRect(isolated.svg, target),
              );
              if (targetRects.some((rect) => !rect)) {
                setResult({
                  ok: false,
                  error: "Selected node has an empty rendered bounding box",
                });
                return;
              }

              const rootRect = isolated.svg.getBoundingClientRect();
              let rect = combineRects(targetRects);

              // Trim transparent edges caused by clip-path / mask so the
              // exported asset only contains visible pixels.
              rect = await trimTransparentEdges(isolated.svg, rect, rootRect);
              if (!rect) {
                setResult({
                  ok: false,
                  error: "Selected nodes do not overlap the root SVG viewport",
                });
                return;
              }

              const padding = exportSpec.padding;
              const clipX = Math.max(0, Math.floor(rect.left - rootRect.left - padding));
              const clipY = Math.max(0, Math.floor(rect.top - rootRect.top - padding));
              const clipRight = Math.min(
                Math.ceil(rootRect.width),
                Math.ceil(rect.right - rootRect.left + padding),
              );
              const clipBottom = Math.min(
                Math.ceil(rootRect.height),
                Math.ceil(rect.bottom - rootRect.top + padding),
              );

              setResult({
                ok: true,
                clip: {
                  x: clipX,
                  y: clipY,
                  width: Math.max(1, clipRight - clipX),
                  height: Math.max(1, clipBottom - clipY),
                },
                renderedBox: {
                  x: rect.left,
                  y: rect.top,
                  width: rect.width,
                  height: rect.height,
                },
                rootSize: {
                  width: isolated.svg.getBoundingClientRect().width,
                  height: isolated.svg.getBoundingClientRect().height,
                },
                selected: targets.map((target) => ({
                  index: allNodes.indexOf(target),
                  tag: target.tagName.toLowerCase(),
                })),
              });
            } catch (error) {
              setResult({
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          });
        });
      });
    </script>
  </body>
</html>
`;

const registerGeneratedAsset = async ({
  args,
  assetBox,
  moduleDir,
  outputPath,
  selectedNodes,
}: {
  args: ParsedArgs;
  assetBox: Clip;
  moduleDir: string;
  outputPath: string;
  selectedNodes: SelectedSemanticNode[];
}) => {
  if (!isModuleLocalPath(moduleDir, outputPath)) {
    throw new Error(
      "--register-semantic requires --output to stay inside the module directory",
    );
  }

  const outputRef = normalizeSlashes(path.relative(moduleDir, outputPath));
  const inferredAssetRole =
    args.assetRole ??
    (selectedNodes.every((node) => node.tag === "image")
      ? "photo-or-bitmap"
      : "visual-asset");
  const textTreatment =
    args.textTreatment ?? GENERATED_ASSET_NO_ORDINARY_TEXT_TREATMENT;
  const assetBaseName = path.basename(outputRef, path.extname(outputRef));
  const sourceNodeIds = selectedNodes.map((node) => node.id);
  // nodePath is stripped by compactDocumentForAgent; fall back to selector
  // (equivalent after the svg:nth-of-type(1) prefix is stripped) so the
  // generatedAsset still records a usable path for re-export/debugging.
  const sourceNodePaths = selectedNodes.map(
    (node) => node.nodePath ?? node.selector,
  );

  let registeredAsset: ModuleSemanticGeneratedAsset | undefined;
  await updateModuleSemanticDocument({
    moduleDir,
    updater: (document) => {
      const assetId =
        document.generatedAssets.find((asset) => asset.path === outputRef)?.id ??
        `${document.module.id}:${assetBaseName}`;
      const nextAsset = {
        assetRole: inferredAssetRole,
        box: assetBox,
        htmlRef: outputRef,
        id: assetId,
        path: outputRef,
        readableByAgent: true,
        relativePath: outputRef,
        source: "module-agent.export-svg-node-asset",
        sourceNodeIds,
        sourceNodePaths,
        textTreatment,
      } satisfies ModuleSemanticGeneratedAsset;
      registeredAsset = nextAsset;
      const existingIndex = document.generatedAssets.findIndex(
        (asset) =>
          asset.id === assetId ||
          asset.path === outputRef ||
          asset.relativePath === outputRef ||
          asset.htmlRef === outputRef,
      );
      const generatedAssets =
        existingIndex >= 0
          ? document.generatedAssets.map((asset, index) =>
              index === existingIndex ? nextAsset : asset,
            )
          : [...document.generatedAssets, nextAsset];
      const summaryStats = {
        ...(typeof document.summaryStats === "object" &&
        document.summaryStats !== null
          ? document.summaryStats
          : {}),
        agentGeneratedAssetCount: generatedAssets.length,
      };
      return {
        ...document,
        generatedAssets,
        summaryStats,
      };
    },
  });

  return registeredAsset;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  if (!args.output) throw new Error("Missing required --output");

  const moduleDir = path.resolve(args.moduleDir);
  const moduleSvgPath = path.isAbsolute(args.moduleSvg)
    ? args.moduleSvg
    : path.resolve(moduleDir, args.moduleSvg);
  const outputPath = path.isAbsolute(args.output)
    ? args.output
    : path.resolve(moduleDir, args.output);

  const semanticDocument = await readModuleSemanticDocument(moduleDir);
  const { nodeById, selectedNodes } = semanticDocument
    ? resolveSelectedSemanticNodes({
        args,
        semanticNodes: semanticDocument.nodes,
      })
    : {
        nodeById: new Map<string, ModuleSemanticNode>(),
        selectedNodes: [] as SelectedSemanticNode[],
      };

  if (args.nodeIds.length > 0 && !semanticDocument) {
    throw new Error(
      "--node-id requires module-semantic.json to exist in the module directory",
    );
  }
  if (!args.allowText && selectedNodes.length > 0) {
    validateSelectedSemanticNodes({ nodeById, selectedNodes });
  }
  if (args.registerSemantic) {
    if (!semanticDocument) {
      throw new Error(
        "--register-semantic requires module-semantic.json to exist in the module directory",
      );
    }
    if (selectedNodes.length === 0) {
      throw new Error(
        "--register-semantic requires a --node-id selection that resolves to node(s) in module-semantic.json",
      );
    }
  }
  const shouldRegisterSemantic =
    args.registerSemantic || selectedNodes.length > 0;

  const wrapperElementIndices =
    selectedNodes.length > 0
      ? selectedNodes.map((node) => node.inspectIndex)
      : args.elementIndex !== undefined
        ? [args.elementIndex]
        : [];
  const wrapperSelector =
    selectedNodes.length === 0 ? args.selector : undefined;

  const svg = await readFile(moduleSvgPath, "utf8");
  const viewportDimensions = readExportViewportDimensions(svg);
  if (!viewportDimensions) {
    throw new Error(`Unable to read SVG dimensions: ${moduleSvgPath}`);
  }
  const wrapperDir = await mkdtemp(path.join(os.tmpdir(), "svg-node-asset-"));
  const wrapperPath = path.join(wrapperDir, "export.html");

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(
    wrapperPath,
    buildWrapperHtml({
      elementIndices: wrapperElementIndices,
      padding: args.padding,
      selector: wrapperSelector,
      svg,
    }),
    "utf8",
  );

  const browser = await launchEdge();

  try {
    const url = pathToFileURL(wrapperPath).href;
    const captureScale = args.scale * PNG_RASTER_SCALE_MULTIPLIER;
    const result = await evaluatePage<ExportResult>({
      deviceScaleFactor: captureScale,
      expression: "window.__EXPORT_RESULT__",
      port: browser.port,
      url,
      viewportHeight: viewportDimensions.height,
      viewportWidth: viewportDimensions.width,
    });

    if (!result?.ok) {
      throw new Error(result?.error ?? "Failed to prepare SVG node export");
    }

    await capturePage({
      clip: result.clip,
      deviceScaleFactor: captureScale,
      outputPath,
      port: browser.port,
      transparentBackground: true,
      url,
      viewportHeight: viewportDimensions.height,
      viewportWidth: viewportDimensions.width,
    });

    const outputRef = normalizeSlashes(path.relative(moduleDir, outputPath));
    const assetBox = roundClip(result.clip);
    const selectedByIndex = new Map(
      selectedNodes.map((node) => [node.inspectIndex, node] as const),
    );
    const manifestEntry = createGeneratedAssetManifestEntry({
      assetRole:
        args.assetRole ??
        (selectedNodes.length > 0 &&
        selectedNodes.every((node) => node.tag === "image")
          ? "photo-or-bitmap"
          : "visual-asset"),
      box: assetBox,
      containsText: false,
      path: outputRef,
      sourceNodeIndex:
        result.selected.length === 1 ? result.selected[0]?.index : undefined,
      sourceNodeTag:
        result.selected.length === 1 ? result.selected[0]?.tag : undefined,
      textTreatment:
        args.textTreatment ?? GENERATED_ASSET_NO_ORDINARY_TEXT_TREATMENT,
    });
    const registeredAsset = shouldRegisterSemantic
      ? await registerGeneratedAsset({
          args,
          assetBox,
          moduleDir,
          outputPath,
          selectedNodes,
        })
      : undefined;

    console.log(
      JSON.stringify(
        {
          clip: result.clip,
          moduleSvgPath,
          outputPath,
          outputRef,
          padding: args.padding,
          captureScale,
          rasterScaleMultiplier: PNG_RASTER_SCALE_MULTIPLIER,
          renderedClip: scaleClip(result.clip, captureScale),
          renderedBox: result.renderedBox,
          renderedPixelBox: scaleClip(result.renderedBox, captureScale),
          rootSize: result.rootSize,
          viewportSize: viewportDimensions,
          scale: args.scale,
          selected: result.selected.map((entry) => ({
            index: entry.index,
            nodeId: selectedByIndex.get(entry.index)?.id,
            nodePath: selectedByIndex.get(entry.index)?.nodePath,
            tag: entry.tag,
          })),
          manifestEntry,
          registeredAsset,
          transparentBackground: true,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
    await rm(wrapperDir, { force: true, recursive: true });
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
