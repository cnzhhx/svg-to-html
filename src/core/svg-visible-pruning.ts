import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { evaluatePage, launchEdge } from "./cdp.js";
import {
  type Box,
  ensureSvgViewBox,
  parsePositiveInteger,
  parseRootChildElements,
  type ResolvedSvgDesign,
  writeJsonFile,
  writeTextFile,
} from "./utils.js";

type SvgVisibilityPrunedNode = {
  changedPixels: number;
  maxDelta: number;
  nodePath: string;
  pixelBox: Box;
  reason: "no-pixel-contribution" | "outside-viewport";
  sampleHits: number;
  sampleTotal: number;
  tag: string;
  totalDelta: number;
};

type SvgVisibilityPruningSummary = {
  candidateCount: number;
  checkedPixelCandidateCount: number;
  error?: string;
  maxPixelCheckCandidates: number;
  outputPath: string;
  prunedNodeCount: number;
  prunedNodes: SvgVisibilityPrunedNode[];
  reportPath: string;
  skippedPixelCandidateCount: number;
  sourcePath: string;
  thresholds: {
    channelDelta: number;
    maxDelta: number;
    minTotalDelta: number;
    totalDeltaPerPixel: number;
  };
};

type SvgVisibilityPruningResult = {
  outputPath: string;
  reportPath: string;
  summary: SvgVisibilityPruningSummary;
};

type BrowserVisibilityPruningResult = {
  candidateCount: number;
  checkedPixelCandidateCount: number;
  maxPixelCheckCandidates: number;
  prunedNodes: SvgVisibilityPrunedNode[];
  skippedPixelCandidateCount: number;
  thresholds: SvgVisibilityPruningSummary["thresholds"];
};

const PRUNED_SVG_NAME = "svg-visible-pruned.svg";
const PRUNING_REPORT_NAME = "svg-visible-pruning.json";
const PRUNING_WRAPPER_NAME = "svg-visible-pruning-source.html";

const MAX_PIXEL_CHECK_CANDIDATES = parsePositiveInteger(
  process.env["SVG_VISIBILITY_PRUNE_MAX_CANDIDATES"],
  32,
);

const THRESHOLDS = {
  channelDelta: 8,
  maxDelta: 4,
  minTotalDelta: 24,
  totalDeltaPerPixel: 0.005,
};

const createWrapper = ({
  height,
  svgMarkup,
  width,
}: {
  height: number;
  svgMarkup: string;
  width: number;
}) => `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, initial-scale=1.0" />
    <style>
      html, body {
        margin: 0;
        width: ${width}px;
        height: ${height}px;
        overflow: hidden;
        background: transparent;
      }

      svg {
        display: block;
        width: ${width}px;
        height: ${height}px;
      }
    </style>
  </head>
  <body>
    ${svgMarkup}
    <script>
      window.__RENDER_READY__ = true
    </script>
  </body>
</html>
`;

const escapeAttribute = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const upsertAttribute = (openTag: string, name: string, value: string) => {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `\\s${escapedName}\\s*=\\s*(["'])([\\s\\S]*?)\\1`,
    "i",
  );
  const attr = ` ${name}="${escapeAttribute(value)}"`;
  if (pattern.test(openTag)) return openTag.replace(pattern, attr);
  const insertAt = openTag.endsWith("/>")
    ? openTag.length - 2
    : openTag.length - 1;
  return `${openTag.slice(0, insertAt)}${attr}${openTag.slice(insertAt)}`;
};

const markOpenTagPruned = (openTag: string, node?: SvgVisibilityPrunedNode) => {
  const styleMatch = openTag.match(/\sstyle\s*=\s*(["'])([\s\S]*?)\1/i);
  const originalStyle = styleMatch?.[2] ?? "";
  const styleWithoutDisplay = originalStyle
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !/^display\s*:/i.test(part))
    .join("; ");
  const style = ["display:none", styleWithoutDisplay]
    .filter(Boolean)
    .join("; ");

  return upsertAttribute(
    upsertAttribute(
      upsertAttribute(
        openTag,
        "data-svg-visibility-pruned",
        node?.reason ?? "true",
      ),
      "data-svg-visibility-pruned-path",
      node?.nodePath ?? "",
    ),
    "style",
    style,
  );
};

const markSvgContentPruned = ({
  content,
  nodeByPath,
  parentPath,
  prunedPaths,
}: {
  content: string;
  nodeByPath: Map<string, SvgVisibilityPrunedNode>;
  parentPath: string;
  prunedPaths: Set<string>;
}): string => {
  const children = parseRootChildElements(content);
  if (!children.length) return content;

  return children
    .map((child) => {
      const childPath = `${parentPath} > ${child.pathSegment}`;
      const prunedNode = nodeByPath.get(childPath);
      if (prunedNode) {
        const openTag = markOpenTagPruned(child.openTag, prunedNode);
        return child.selfClosing
          ? openTag
          : `${openTag}${child.innerContent}${child.closeTag}`;
      }

      const hasPrunedDescendant = [...prunedPaths].some((nodePath) =>
        nodePath.startsWith(`${childPath} > `),
      );
      if (!hasPrunedDescendant || child.selfClosing) return child.content;

      return `${child.openTag}${markSvgContentPruned({
        content: child.innerContent,
        nodeByPath,
        parentPath: childPath,
        prunedPaths,
      })}${child.closeTag}`;
    })
    .join("\n");
};

const markSvgSourcePruned = ({
  nodes,
  source,
}: {
  nodes: SvgVisibilityPrunedNode[];
  source: string;
}) => {
  if (!nodes.length) return source;
  const svgContentMatch = source.match(/<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/i);
  if (!svgContentMatch?.[1]) return source;

  const nodeByPath = new Map(
    nodes.map((node) => [node.nodePath, node] as const),
  );
  const prunedPaths = new Set(nodeByPath.keys());
  const markedContent = markSvgContentPruned({
    content: svgContentMatch[1],
    nodeByPath,
    parentPath: "svg:nth-of-type(1)",
    prunedPaths,
  });

  return source.replace(svgContentMatch[1], markedContent);
};

const createPruningExpression = () => `(() => {
  const thresholds = ${JSON.stringify(THRESHOLDS)};
  const maxPixelCheckCandidates = ${JSON.stringify(MAX_PIXEL_CHECK_CANDIDATES)};
  const root = document.querySelector("svg");
  if (!(root instanceof SVGSVGElement)) throw new Error("SVG root not found");

  const rootRect = root.getBoundingClientRect();
  const viewport = {
    x: rootRect.left,
    y: rootRect.top,
    width: rootRect.width,
    height: rootRect.height,
  };
  const renderedWidth = Math.max(1, Math.ceil(rootRect.width));
  const renderedHeight = Math.max(1, Math.ceil(rootRect.height));
  const serializer = new XMLSerializer();
  const resourceSelector =
    "defs,mask,clipPath,pattern,linearGradient,radialGradient,filter,marker,symbol,style";
  const candidateSelector =
    "g,path,rect,circle,ellipse,line,polyline,polygon,image,use,text,tspan";
  const sampleFractions = [0.15, 0.3, 0.5, 0.7, 0.85];

  const buildNodePath = (node) => {
    const segments = [];
    let current = node;
    while (current && current instanceof SVGElement) {
      const parent = current.parentElement;
      const tag = current.tagName.toLowerCase();
      const siblings = parent
        ? [...parent.children].filter((item) => item.tagName === current.tagName)
        : [current];
      const index = siblings.indexOf(current) + 1;
      segments.unshift(tag + ":nth-of-type(" + index + ")");
      if (current === root) break;
      current = parent;
    }
    return segments.join(" > ");
  };

  const toPixelBox = (rect) => ({
    x: Number((rect.left - rootRect.left).toFixed(3)),
    y: Number((rect.top - rootRect.top).toFixed(3)),
    width: Number(rect.width.toFixed(3)),
    height: Number(rect.height.toFixed(3)),
  });

  const intersectsViewport = (rect) =>
    rect.right > viewport.x &&
    rect.bottom > viewport.y &&
    rect.left < viewport.x + viewport.width &&
    rect.top < viewport.y + viewport.height;

  const sampleVisibility = (el, rect) => {
    let hits = 0;
    let total = 0;
    for (const fx of sampleFractions) {
      for (const fy of sampleFractions) {
        const x = rect.left + rect.width * fx;
        const y = rect.top + rect.height * fy;
        if (
          x < viewport.x ||
          x >= viewport.x + viewport.width ||
          y < viewport.y ||
          y >= viewport.y + viewport.height
        ) {
          continue;
        }
        total += 1;
        let hit = document.elementFromPoint(x, y);
        while (hit && !(hit instanceof SVGElement)) hit = hit.parentElement;
        if (hit && (hit === el || el.contains(hit))) hits += 1;
      }
    }
    return { hits, total };
  };

  const toRegion = (rect) => {
    const x = Math.max(0, Math.floor(rect.left - rootRect.left - 1));
    const y = Math.max(0, Math.floor(rect.top - rootRect.top - 1));
    const right = Math.min(
      renderedWidth,
      Math.ceil(rect.right - rootRect.left + 1),
    );
    const bottom = Math.min(
      renderedHeight,
      Math.ceil(rect.bottom - rootRect.top + 1),
    );
    return {
      x,
      y,
      width: Math.max(1, right - x),
      height: Math.max(1, bottom - y),
    };
  };

  const renderRegion = async (region) => {
    const source = serializer.serializeToString(root);
    const blob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    try {
      const image = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("SVG image decode failed"));
        img.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = region.width;
      canvas.height = region.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(
        image,
        region.x,
        region.y,
        region.width,
        region.height,
        0,
        0,
        region.width,
        region.height,
      );
      return ctx.getImageData(0, 0, region.width, region.height).data;
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const compareHidden = async (el, region) => {
    const before = await renderRegion(region);
    const originalDisplay = el.getAttribute("display");
    const originalStyle = el.getAttribute("style");
    const nextStyle = originalStyle
      ? "display:none;" + originalStyle.replace(/(?:^|;)\\s*display\\s*:[^;]*/gi, "")
      : "display:none";
    el.setAttribute("style", nextStyle);
    el.setAttribute("display", "none");
    const after = await renderRegion(region);
    if (originalDisplay === null) el.removeAttribute("display");
    else el.setAttribute("display", originalDisplay);
    if (originalStyle === null) el.removeAttribute("style");
    else el.setAttribute("style", originalStyle);

    let changedPixels = 0;
    let maxDelta = 0;
    let totalDelta = 0;
    for (let index = 0; index < before.length; index += 4) {
      const delta =
        Math.abs(before[index] - after[index]) +
        Math.abs(before[index + 1] - after[index + 1]) +
        Math.abs(before[index + 2] - after[index + 2]) +
        Math.abs(before[index + 3] - after[index + 3]);
      if (delta > thresholds.channelDelta) changedPixels += 1;
      if (delta > maxDelta) maxDelta = delta;
      totalDelta += delta;
    }
    return { changedPixels, maxDelta, totalDelta };
  };

  const hideForRemainder = (el, reason) => {
    const originalStyle = el.getAttribute("style");
    const nextStyle = originalStyle
      ? "display:none;" + originalStyle.replace(/(?:^|;)\\s*display\\s*:[^;]*/gi, "")
      : "display:none";
    el.setAttribute("style", nextStyle);
    el.setAttribute("display", "none");
    el.setAttribute("data-svg-visibility-pruned", reason);
  };

  const isPixelInert = (comparison, region) => {
    const area = Math.max(1, region.width * region.height);
    return (
      comparison.changedPixels === 0 &&
      comparison.maxDelta <= thresholds.maxDelta &&
      comparison.totalDelta <=
        Math.max(thresholds.minTotalDelta, area * thresholds.totalDeltaPerPixel)
    );
  };

  return (async () => {
    const candidates = [];
    for (const el of [...root.querySelectorAll(candidateSelector)]) {
      if (!(el instanceof SVGElement)) continue;
      if (el === root) continue;
      if (el.closest(resourceSelector)) continue;
      const rect = el.getBoundingClientRect();
      if (!rect.width && !rect.height) continue;

      const sample = sampleVisibility(el, rect);
      const outsideViewport = !intersectsViewport(rect);
      if (!outsideViewport && sample.hits > 1) continue;

      candidates.push({
        el,
        nodePath: buildNodePath(el),
        outsideViewport,
        pixelBox: toPixelBox(rect),
        rect,
        sampleHits: sample.hits,
        sampleTotal: sample.total,
        tag: el.tagName.toLowerCase(),
      });
    }

    const prunedNodes = [];
    let checkedPixelCandidateCount = 0;
    let skippedPixelCandidateCount = 0;

    for (const candidate of candidates) {
      if (candidate.el.closest("[data-svg-visibility-pruned]")) continue;
      if (candidate.outsideViewport) {
        hideForRemainder(candidate.el, "outside-viewport");
        prunedNodes.push({
          changedPixels: 0,
          maxDelta: 0,
          nodePath: candidate.nodePath,
          pixelBox: candidate.pixelBox,
          reason: "outside-viewport",
          sampleHits: candidate.sampleHits,
          sampleTotal: candidate.sampleTotal,
          tag: candidate.tag,
          totalDelta: 0,
        });
        continue;
      }

      if (checkedPixelCandidateCount >= maxPixelCheckCandidates) {
        skippedPixelCandidateCount += 1;
        continue;
      }

      checkedPixelCandidateCount += 1;
      const region = toRegion(candidate.rect);
      const comparison = await compareHidden(candidate.el, region);
      if (!isPixelInert(comparison, region)) continue;

      hideForRemainder(candidate.el, "no-pixel-contribution");
      prunedNodes.push({
        changedPixels: comparison.changedPixels,
        maxDelta: comparison.maxDelta,
        nodePath: candidate.nodePath,
        pixelBox: candidate.pixelBox,
        reason: "no-pixel-contribution",
        sampleHits: candidate.sampleHits,
        sampleTotal: candidate.sampleTotal,
        tag: candidate.tag,
        totalDelta: comparison.totalDelta,
      });
    }

    return {
      candidateCount: candidates.length,
      checkedPixelCandidateCount,
      maxPixelCheckCandidates,
      prunedNodes,
      skippedPixelCandidateCount,
      thresholds,
    };
  })();
})()`;

const shouldPruneInvisibleSvgNodes = () =>
  process.env["SVG_VISIBILITY_PRUNE"] === "1";

const pruneInvisibleSvgNodes = async ({
  artifactDir,
  design,
}: {
  artifactDir: string;
  design: ResolvedSvgDesign;
}): Promise<SvgVisibilityPruningResult> => {
  const source = ensureSvgViewBox(await readFile(design.svgPath, "utf8"));
  const wrapperPath = path.join(artifactDir, PRUNING_WRAPPER_NAME);
  const outputPath = path.join(artifactDir, PRUNED_SVG_NAME);
  const reportPath = path.join(artifactDir, PRUNING_REPORT_NAME);

  await writeTextFile(
    wrapperPath,
    createWrapper({
      height: design.height,
      svgMarkup: source,
      width: design.width,
    }),
  );

  let browserResult: BrowserVisibilityPruningResult;
  try {
    const browser = await launchEdge();
    browserResult = await evaluatePage<BrowserVisibilityPruningResult>({
      deviceScaleFactor: design.scale,
      expression: createPruningExpression(),
      port: browser.port,
      url: pathToFileURL(wrapperPath).href,
      viewportHeight: design.height,
      viewportWidth: design.width,
    }).finally(async () => {
      await browser.close();
    });
  } catch (error) {
    const summary: SvgVisibilityPruningSummary = {
      candidateCount: 0,
      checkedPixelCandidateCount: 0,
      error: error instanceof Error ? error.message : String(error),
      maxPixelCheckCandidates: MAX_PIXEL_CHECK_CANDIDATES,
      outputPath,
      prunedNodeCount: 0,
      prunedNodes: [],
      reportPath,
      skippedPixelCandidateCount: 0,
      sourcePath: design.svgPath,
      thresholds: THRESHOLDS,
    };
    await writeTextFile(outputPath, source);
    await writeJsonFile(reportPath, summary);
    return {
      outputPath,
      reportPath,
      summary,
    };
  }

  const prunedSource = markSvgSourcePruned({
    nodes: browserResult.prunedNodes,
    source,
  });
  await writeTextFile(outputPath, prunedSource);

  const summary: SvgVisibilityPruningSummary = {
    candidateCount: browserResult.candidateCount,
    checkedPixelCandidateCount: browserResult.checkedPixelCandidateCount,
    maxPixelCheckCandidates: browserResult.maxPixelCheckCandidates,
    outputPath,
    prunedNodeCount: browserResult.prunedNodes.length,
    prunedNodes: browserResult.prunedNodes,
    reportPath,
    skippedPixelCandidateCount: browserResult.skippedPixelCandidateCount,
    sourcePath: design.svgPath,
    thresholds: browserResult.thresholds,
  };
  await writeJsonFile(reportPath, summary);

  return {
    outputPath,
    reportPath,
    summary,
  };
};

export { pruneInvisibleSvgNodes, shouldPruneInvisibleSvgNodes };
