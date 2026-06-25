import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { evaluatePage, launchEdge } from "../core/cdp.js";
import { writeJsonFile, writeTextFile } from "../core/file-io.js";
import { toUrlPath } from "../core/paths.js";
import { startStaticServer } from "../core/static-server.js";
import { isRecord } from "../core/type-guards.js";
import { parseCliFlags } from "./cli-utils.js";

type Rect = {
  height: number;
  width: number;
  x: number;
  y: number;
};

type Delta = {
  dh: number;
  dw: number;
  dx: number;
  dy: number;
};

type Severity = "ok" | "minor" | "major";
type TargetKind = "asset" | "text";
type UnmatchedStatus =
  | "ambiguous-dom"
  | "missing-dom"
  | "missing-expected-box";

type SemanticAssetTarget = {
  assetId?: string;
  assetPath?: string;
  expected: Rect;
  kind: "asset";
  refs: string[];
  targetId: string;
};

type SemanticTextTarget = {
  expected: Rect;
  kind: "text";
  targetId: string;
  text: string;
};

type DiagnosticEntry = {
  actionable: boolean;
  actual?: Rect;
  assetPath?: string;
  delta?: Delta;
  expected?: Rect;
  hint: string;
  kind: TargetKind;
  match?: string;
  maxDeviation?: number;
  severity: Severity;
  status?: UnmatchedStatus;
  targetId: string;
  text?: string;
};

type MeasuredElement = {
  attrSrc: string;
  currentSrc: string;
  dataAssetId: string;
  dataNodeId: string;
  index: number;
  naturalHeight: number;
  naturalWidth: number;
  rect: Rect;
  src: string;
  tagName: string;
  text: string;
};

type HtmlImageError = {
  alt: string;
  currentSrc: string;
  naturalHeight: number;
  naturalWidth: number;
  src: string;
};

type DomMeasurement = {
  dataAssetElements: MeasuredElement[];
  dataNodeElements: MeasuredElement[];
  imageElements: MeasuredElement[];
  imageLoadErrors: HtmlImageError[];
  leafTextElements: MeasuredElement[];
  root: {
    candidateCount: number;
    rect: Rect;
    strategy: string;
  };
};

type SemanticInput = {
  assetTargets: SemanticAssetTarget[];
  missingExpected: DiagnosticEntry[];
  module: {
    height: number;
    id: string;
    width: number;
  };
  textTargets: SemanticTextTarget[];
};

type RenderEntryResolution = {
  mode: "explicit" | "verify-round" | "light-wrapper";
  path: string;
  verifyRound?: number;
};

type CliArgs = {
  diffRatio?: number;
  help: boolean;
  json: boolean;
  moduleDir: string;
  moduleId?: string;
  output?: string;
  renderEntry?: string;
  scale?: number;
  verifyRound?: number;
};

type AlignmentDiagnosticsSummary = {
  alignedTargets: number;
  ambiguousTargets: number;
  assetTargets: number;
  likelyNonActionablePixelDiff: boolean;
  majorIssues: number;
  matchedTargets: number;
  minorIssues: number;
  missingExpectedBoxes: number;
  missingTargets: number;
  pixelDiffRatio: number | null;
  textTargets: number;
  unmatchedTargets: number;
};

type AlignmentDiagnosticsReport = ReturnType<typeof buildReport>;

type DiagnoseModuleAlignmentInput = {
  diffRatio?: number;
  json?: boolean;
  moduleDir: string;
  moduleId?: string;
  output?: string;
  renderEntry?: string;
  scale?: number;
  verifyRound?: number;
};

type MeasureModuleAlignmentInput = Omit<
  DiagnoseModuleAlignmentInput,
  "diffRatio" | "json" | "output"
>;

type MeasuredModuleAlignment = {
  moduleDir: string;
  measurement: DomMeasurement;
  moduleId?: string;
  renderEntry: RenderEntryResolution;
  scale?: number;
  semantic: SemanticInput;
};

type WriteMeasuredModuleAlignmentInput = {
  diffRatio?: number;
  output?: string;
};

type DiagnoseModuleAlignmentResult = {
  outputPath: string;
  report: AlignmentDiagnosticsReport;
  summary: AlignmentDiagnosticsSummary & {
    alignmentDiagnosticsPath: string;
  };
};

const VALUE_FLAGS = new Set([
  "--diff-ratio",
  "--diffRatio",
  "--module-dir",
  "--moduleDir",
  "--module-id",
  "--moduleId",
  "--output",
  "--render-entry",
  "--renderEntry",
  "--round",
  "--scale",
  "--verify-round",
  "--verifyRound",
]);

const roundMetric = (value: number) =>
  Number.isInteger(value) ? value : Number(value.toFixed(3));

const roundRect = (rect: Rect): Rect => ({
  height: roundMetric(rect.height),
  width: roundMetric(rect.width),
  x: roundMetric(rect.x),
  y: roundMetric(rect.y),
});

const roundDelta = (delta: Delta): Delta => ({
  dh: roundMetric(delta.dh),
  dw: roundMetric(delta.dw),
  dx: roundMetric(delta.dx),
  dy: roundMetric(delta.dy),
});

const toFiniteNumber = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const parseRect = (value: unknown): Rect | undefined => {
  if (!isRecord(value)) return undefined;
  const x = toFiniteNumber(value.x);
  const y = toFiniteNumber(value.y);
  const width = toFiniteNumber(value.width);
  const height = toFiniteNumber(value.height);
  if (
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined ||
    width <= 0 ||
    height <= 0
  ) {
    return undefined;
  }
  return { height, width, x, y };
};

const uniqueStrings = (values: Array<string | undefined>) =>
  [...new Set(values.filter((value): value is string => Boolean(value)))];

const createMissingExpectedEntry = ({
  assetPath,
  kind,
  targetId,
  text,
}: {
  assetPath?: string;
  kind: TargetKind;
  targetId: string;
  text?: string;
}): DiagnosticEntry => ({
  actionable: true,
  assetPath,
  hint:
    kind === "asset"
      ? "module-semantic.json 中该图片资产缺少有效 asset.box，跳过位置测量；需要先修复资产登记或导出流程。"
      : "module-semantic.json 中该文本缺少有效 layoutTargetRegion，跳过位置测量；需要先修复文本预处理结果。",
  kind,
  severity: "major",
  status: "missing-expected-box",
  targetId,
  text,
});

const readModuleSemantic = async (
  moduleDir: string,
  moduleIdOverride?: string,
): Promise<SemanticInput> => {
  const semanticPath = path.join(moduleDir, "module-semantic.json");
  const parsed = JSON.parse(await readFile(semanticPath, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Invalid module semantic JSON: ${semanticPath}`);
  }

  const moduleRecord = isRecord(parsed.module) ? parsed.module : {};
  const region = parseRect(moduleRecord.region);
  if (!region) {
    throw new Error(
      `module-semantic.json is missing a valid module.region: ${semanticPath}`,
    );
  }
  const moduleId =
    moduleIdOverride ??
    (typeof moduleRecord.id === "string" ? moduleRecord.id : path.basename(moduleDir));

  const missingExpected: DiagnosticEntry[] = [];
  const assetTargets: SemanticAssetTarget[] = [];
  const rawAssets = Array.isArray(parsed.generatedAssets)
    ? parsed.generatedAssets
    : [];

  rawAssets.forEach((rawAsset, index) => {
    if (!isRecord(rawAsset)) return;
    const assetId = typeof rawAsset.id === "string" ? rawAsset.id : undefined;
    const assetPath =
      typeof rawAsset.path === "string" ? rawAsset.path : undefined;
    const refs = uniqueStrings([
      assetPath,
      typeof rawAsset.htmlRef === "string" ? rawAsset.htmlRef : undefined,
      typeof rawAsset.relativePath === "string"
        ? rawAsset.relativePath
        : undefined,
    ]);
    const targetId = assetId ?? assetPath ?? `asset:${index + 1}`;
    const expected = parseRect(rawAsset.box);
    if (!expected) {
      missingExpected.push(
        createMissingExpectedEntry({
          assetPath,
          kind: "asset",
          targetId,
        }),
      );
      return;
    }
    assetTargets.push({
      assetId,
      assetPath,
      expected,
      kind: "asset",
      refs,
      targetId,
    });
  });

  const textTargets: SemanticTextTarget[] = [];
  const rawTextBlocks = Array.isArray(parsed.textBlocks) ? parsed.textBlocks : [];
  rawTextBlocks.forEach((rawTextBlock, index) => {
    if (!isRecord(rawTextBlock)) return;
    const targetId =
      typeof rawTextBlock.id === "string"
        ? rawTextBlock.id
        : `text:${index + 1}`;
    const text =
      typeof rawTextBlock.text === "string" ? rawTextBlock.text : "";
    const expected = parseRect(rawTextBlock.layoutTargetRegion);
    if (!expected) {
      missingExpected.push(
        createMissingExpectedEntry({
          kind: "text",
          targetId,
          text,
        }),
      );
      return;
    }
    textTargets.push({
      expected,
      kind: "text",
      targetId,
      text,
    });
  });

  return {
    assetTargets,
    missingExpected,
    module: {
      height: region.height,
      id: moduleId,
      width: region.width,
    },
    textTargets,
  };
};

const escapeHtmlAttribute = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const buildLightWrapper = async ({
  height,
  moduleCss,
  moduleDir,
  moduleId,
  previewFragmentHtml,
  width,
}: {
  height: number;
  moduleCss: string;
  moduleDir: string;
  moduleId: string;
  previewFragmentHtml: string;
  width: number;
}) => {
  const wrapperPath = path.join(moduleDir, ".alignment-diagnostics-preview.html");
  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=${width}, initial-scale=1" />
    <style>
      html,
      body {
        margin: 0;
        width: ${width}px;
        height: ${height}px;
        overflow: hidden;
        background: transparent;
      }

      .design-page {
        position: relative;
        width: ${width}px;
        height: ${height}px;
        overflow: hidden;
      }

      .design-module {
        position: absolute;
        left: 0;
        top: 0;
        width: ${width}px;
        height: ${height}px;
        overflow: hidden;
        background: transparent;
      }

      .design-module,
      .design-module * {
        box-sizing: border-box;
      }

${moduleCss
  .split("\n")
  .map((line) => `      ${line}`)
  .join("\n")}
    </style>
  </head>
  <body>
    <main class="design-page">
      <section class="design-module ${escapeHtmlAttribute(moduleId)}" data-module-id="${escapeHtmlAttribute(moduleId)}">
${previewFragmentHtml
  .split("\n")
  .map((line) => `        ${line}`)
  .join("\n")}
      </section>
    </main>
  </body>
</html>
`;
  await writeTextFile(wrapperPath, html);
  return wrapperPath;
};

const resolveExistingPath = (inputPath: string, baseDir: string, label: string) => {
  const resolved = path.isAbsolute(inputPath)
    ? inputPath
    : path.resolve(baseDir, inputPath);
  if (!existsSync(resolved)) throw new Error(`${label} not found: ${resolved}`);
  return resolved;
};

const resolveRenderEntry = async ({
  args,
  semantic,
}: {
  args: CliArgs;
  semantic: SemanticInput;
}): Promise<RenderEntryResolution> => {
  const moduleDir = path.resolve(args.moduleDir);
  if (args.renderEntry && args.verifyRound !== undefined) {
    throw new Error("Use either --render-entry or --verify-round, not both.");
  }
  if (args.renderEntry) {
    return {
      mode: "explicit",
      path: resolveExistingPath(args.renderEntry, moduleDir, "render entry"),
    };
  }
  if (args.verifyRound !== undefined) {
    const previewPath = path.join(
      moduleDir,
      `module-preview-round-${args.verifyRound}.html`,
    );
    if (!existsSync(previewPath)) {
      throw new Error(`verify preview not found: ${previewPath}`);
    }
    return {
      mode: "verify-round",
      path: previewPath,
      verifyRound: args.verifyRound,
    };
  }

  const [previewFragmentHtml, moduleCss] = await Promise.all([
    readFile(path.join(moduleDir, "preview.fragment.html"), "utf8"),
    readFile(path.join(moduleDir, "module.css"), "utf8"),
  ]);
  const wrapperPath = await buildLightWrapper({
    height: semantic.module.height,
    moduleCss,
    moduleDir,
    moduleId: semantic.module.id,
    previewFragmentHtml,
    width: semantic.module.width,
  });
  return {
    mode: "light-wrapper",
    path: wrapperPath,
  };
};

const buildMeasurementExpression = ({
  height,
  moduleId,
  width,
}: {
  height: number;
  moduleId: string;
  width: number;
}) => {
  const measure = async (input: {
    height: number;
    moduleId: string;
    width: number;
  }) => {
    const rectOf = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return {
        height: rect.height,
        width: rect.width,
        x: rect.left,
        y: rect.top,
      };
    };

    const waitForImages = async () => {
      const errors: HtmlImageError[] = [];
      const images = [...document.querySelectorAll("img")];
      await Promise.all(
        images.map((image) => {
          const recordError = () => {
            if (image.naturalWidth > 0 && image.naturalHeight > 0) return;
            errors.push({
              alt: image.getAttribute("alt") || "",
              currentSrc: image.currentSrc || "",
              naturalHeight: image.naturalHeight || 0,
              naturalWidth: image.naturalWidth || 0,
              src: image.getAttribute("src") || "",
            });
          };
          if (image.complete) {
            recordError();
            return Promise.resolve();
          }
          return new Promise<void>((resolve) => {
            image.addEventListener(
              "load",
              () => {
                resolve();
              },
              { once: true },
            );
            image.addEventListener(
              "error",
              () => {
                recordError();
                resolve();
              },
              { once: true },
            );
          });
        }),
      );
      return errors;
    };

    const waitForPaint = () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });

    const imageLoadErrors = await waitForImages();
    if (document.fonts?.ready) {
      try {
        await document.fonts.ready;
      } catch {}
    }
    await waitForPaint();

    const elements = [...document.querySelectorAll("*")];
    const visibleRect = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      const opacity = Number.parseFloat(style.opacity || "1");
      if (style.display === "none") return null;
      if (style.visibility === "hidden" || style.visibility === "collapse") {
        return null;
      }
      if (Number.isFinite(opacity) && opacity <= 0) return null;
      if (rect.width <= 0 || rect.height <= 0) return null;
      return rect;
    };

    const scoreRootCandidate = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const widthDelta = Math.abs(rect.width - input.width);
      const heightDelta = Math.abs(rect.height - input.height);
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      const parent = element.parentElement;
      const parentHasSameIdentity = Boolean(
        parent &&
          (parent.getAttribute("data-module-id") === input.moduleId ||
            parent.classList.contains(input.moduleId) ||
            parent.classList.contains("design-module")),
      );
      return widthDelta + heightDelta + (parentHasSameIdentity ? 0.001 : 0) - area / 1_000_000_000;
    };
    const chooseRoot = (candidates: Element[]) =>
      [...candidates].sort((a, b) => scoreRootCandidate(a) - scoreRootCandidate(b))[0];

    const dataRoots = elements.filter(
      (element) => element.getAttribute("data-module-id") === input.moduleId,
    );
    const classRoots = [...document.getElementsByClassName(input.moduleId)];
    const designRoots = [...document.querySelectorAll(".design-module")];
    const sizeCandidates = [document.body, ...elements].filter((element) => {
      const rect = visibleRect(element);
      if (!rect) return false;
      const widthTolerance = Math.max(2, input.width * 0.02);
      const heightTolerance = Math.max(2, input.height * 0.02);
      return (
        Math.abs(rect.width - input.width) <= widthTolerance &&
        Math.abs(rect.height - input.height) <= heightTolerance
      );
    });

    let root: Element = document.body;
    let strategy = "body-fallback";
    let candidateCount = 0;
    if (dataRoots.length > 0) {
      const candidate = chooseRoot(dataRoots);
      if (candidate) root = candidate;
      strategy =
        dataRoots.length === 1
          ? "data-module-id"
          : "data-module-id:best-size-match";
      candidateCount = dataRoots.length;
    } else if (classRoots.length > 0) {
      const candidate = chooseRoot(classRoots);
      if (candidate) root = candidate;
      strategy =
        classRoots.length === 1 ? "module-class" : "module-class:best-size-match";
      candidateCount = classRoots.length;
    } else if (designRoots.length > 0) {
      const candidate = chooseRoot(designRoots);
      if (candidate) root = candidate;
      strategy =
        designRoots.length === 1
          ? "design-module"
          : "design-module:best-size-match";
      candidateCount = designRoots.length;
    } else if (sizeCandidates.length === 1) {
      const first = sizeCandidates[0];
      if (first) root = first;
      strategy = "unique-module-size-root";
      candidateCount = 1;
    } else {
      candidateCount = sizeCandidates.length;
    }

    const scopedElements = [root, ...root.querySelectorAll("*")];

    const elementIndexes = new Map<Element, number>();
    elements.forEach((element, index) => {
      elementIndexes.set(element, index);
    });

    const summarize = (element: Element): MeasuredElement => {
      const image = element instanceof HTMLImageElement ? element : null;
      return {
        attrSrc: image?.getAttribute("src") || "",
        currentSrc: image?.currentSrc || "",
        dataAssetId: element.getAttribute("data-asset-id") || "",
        dataNodeId: element.getAttribute("data-node-id") || "",
        index: elementIndexes.get(element) ?? -1,
        naturalHeight: image?.naturalHeight || 0,
        naturalWidth: image?.naturalWidth || 0,
        rect: rectOf(element),
        src: image?.src || "",
        tagName: element.tagName.toLowerCase(),
        text: element.textContent || "",
      };
    };

    const leafTextElements = elements
      .filter((element) => {
        if (!root.contains(element)) return false;
        if (element.children.length > 0) return false;
        if (!visibleRect(element)) return false;
        return (element.textContent || "").length > 0;
      })
      .map(summarize);

    return {
      dataAssetElements: [
        ...scopedElements.filter((element) => element.hasAttribute("data-asset-id")),
      ].map(summarize),
      dataNodeElements: scopedElements
        .filter((element) => element.hasAttribute("data-node-id"))
        .map(summarize),
      imageElements: scopedElements
        .filter((element): element is HTMLImageElement => element instanceof HTMLImageElement)
        .map(summarize),
      imageLoadErrors,
      leafTextElements,
      root: {
        candidateCount,
        rect: rectOf(root),
        strategy,
      },
    };
  };

  return `(() => {
    const __name = (fn) => fn;
    return (${measure.toString()})(${JSON.stringify({ height, moduleId, width })});
  })()`;
};

const resolveNavigationUrl = async (renderEntryPath: string) => {
  try {
    const urlPath = toUrlPath(renderEntryPath);
    const server = await startStaticServer();
    return {
      close: server.close,
      url: `${server.origin}${urlPath}`,
    };
  } catch {
    return {
      close: async () => {},
      url: pathToFileURL(renderEntryPath).href,
    };
  }
};

const measureDom = async ({
  renderEntryPath,
  semantic,
}: {
  renderEntryPath: string;
  semantic: SemanticInput;
}) => {
  const navigation = await resolveNavigationUrl(renderEntryPath);
  const browser = await launchEdge();
  try {
    return await evaluatePage<DomMeasurement>({
      deviceScaleFactor: 1,
      expression: buildMeasurementExpression({
        height: semantic.module.height,
        moduleId: semantic.module.id,
        width: semantic.module.width,
      }),
      port: browser.port,
      readyExpression: 'document.readyState === "complete"',
      url: navigation.url,
      viewportHeight: semantic.module.height,
      viewportWidth: semantic.module.width,
    });
  } finally {
    await Promise.allSettled([browser.close(), navigation.close()]);
  }
};

const buildElementIndex = (
  elements: MeasuredElement[],
  key: keyof Pick<MeasuredElement, "dataAssetId" | "dataNodeId">,
) => {
  const index = new Map<string, MeasuredElement[]>();
  for (const element of elements) {
    const value = element[key];
    if (!value) continue;
    index.set(value, [...(index.get(value) ?? []), element]);
  }
  return index;
};

const normalizePathLike = (value: string) => {
  let next = value.split(/[?#]/)[0] ?? "";
  try {
    next = new URL(value).pathname;
  } catch {}
  try {
    next = decodeURIComponent(next);
  } catch {}
  return next.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
};

const sourceMatchesRef = (source: string, ref: string) => {
  const sourcePath = normalizePathLike(source);
  const refPath = normalizePathLike(ref);
  if (!sourcePath || !refPath) return false;
  return (
    sourcePath === refPath ||
    sourcePath.endsWith(`/${refPath}`) ||
    refPath.endsWith(`/${sourcePath}`)
  );
};

const refsOverlap = (leftRefs: string[], rightRefs: string[]) =>
  leftRefs.some((leftRef) =>
    rightRefs.some(
      (rightRef) =>
        sourceMatchesRef(leftRef, rightRef) ||
        sourceMatchesRef(rightRef, leftRef),
    ),
  );

const collectImageCandidatesByRefs = (
  images: MeasuredElement[],
  refs: string[],
  claimedElementIndexes: Set<number>,
) => {
  const matches = new Map<number, MeasuredElement>();
  for (const image of images) {
    if (claimedElementIndexes.has(image.index)) continue;
    const sources = [image.attrSrc, image.currentSrc, image.src].filter(Boolean);
    const matched = refs.some((ref) =>
      sources.some((source) => sourceMatchesRef(source, ref)),
    );
    if (matched) matches.set(image.index, image);
  }
  return [...matches.values()];
};

const collectTextCandidatesByContent = (
  leafTextElements: MeasuredElement[],
  text: string,
  claimedElementIndexes: Set<number>,
) =>
  leafTextElements.filter(
    (element) =>
      !claimedElementIndexes.has(element.index) && element.text === text,
  );

const toModuleRect = ({
  elementRect,
  rootRect,
  scaleX,
  scaleY,
}: {
  elementRect: Rect;
  rootRect: Rect;
  scaleX: number;
  scaleY: number;
}): Rect => ({
  height: elementRect.height / scaleY,
  width: elementRect.width / scaleX,
  x: (elementRect.x - rootRect.x) / scaleX,
  y: (elementRect.y - rootRect.y) / scaleY,
});

const calculateDelta = (expected: Rect, actual: Rect): Delta => ({
  dh: actual.height - expected.height,
  dw: actual.width - expected.width,
  dx: actual.x - expected.x,
  dy: actual.y - expected.y,
});

const maxDeviation = (delta: Delta) =>
  Math.max(
    Math.abs(delta.dx),
    Math.abs(delta.dy),
    Math.abs(delta.dw),
    Math.abs(delta.dh),
  );

const severityForDeviation = (value: number): Severity => {
  if (value <= 1) return "ok";
  if (value <= 3) return "minor";
  return "major";
};

const createMatchedEntry = ({
  actual,
  assetPath,
  expected,
  kind,
  match,
  targetId,
  text,
}: {
  actual: Rect;
  assetPath?: string;
  expected: Rect;
  kind: TargetKind;
  match: string;
  targetId: string;
  text?: string;
}): DiagnosticEntry => {
  const delta = calculateDelta(expected, actual);
  const deviation = maxDeviation(delta);
  const severity = severityForDeviation(deviation);
  return {
    actionable: severity !== "ok",
    actual: roundRect(actual),
    assetPath,
    delta: roundDelta(delta),
    expected: roundRect(expected),
    hint:
      severity === "ok"
        ? "可测目标已在 1px 内对齐。"
        : kind === "asset"
          ? "图片最终位置/尺寸存在偏差；若同一组图片同向偏移，优先检查父容器 gap/padding/margin 或 item 内部定位。"
          : "文本外盒位置/尺寸存在偏差；只允许调整文本外盒或父容器，不要修改 font-size/font-weight/line-height/font-family/color。",
    kind,
    match,
    maxDeviation: roundMetric(deviation),
    severity,
    targetId,
    text,
  };
};

const createUnmatchedEntry = ({
  assetPath,
  candidateCount,
  kind,
  status,
  targetId,
  text,
}: {
  assetPath?: string;
  candidateCount?: number;
  kind: TargetKind;
  status: Exclude<UnmatchedStatus, "missing-expected-box">;
  targetId: string;
  text?: string;
}): DiagnosticEntry => {
  const ambiguous = status === "ambiguous-dom";
  return {
    actionable: true,
    assetPath,
    hint:
      kind === "asset"
        ? ambiguous
          ? `找到 ${candidateCount ?? "多个"} 个候选图片元素；请给目标 img 添加唯一 data-asset-id，诊断不会猜测绑定。`
          : "HTML 中未找到该资产对应 img；检查是否漏用、src 路径不一致，或缺少 data-asset-id。"
        : ambiguous
          ? `找到 ${candidateCount ?? "多个"} 个相同文本候选；请给目标文本元素添加唯一 data-node-id，诊断不会猜测绑定。`
          : "HTML 中未找到该文本对应 DOM 元素；检查是否漏写文本，或缺少 data-node-id。",
    kind,
    severity: "major",
    status,
    targetId,
    text,
  };
};

const matchAssets = ({
  assetTargets,
  dataAssetIndex,
  imageElements,
  rootRect,
  scaleX,
  scaleY,
}: {
  assetTargets: SemanticAssetTarget[];
  dataAssetIndex: Map<string, MeasuredElement[]>;
  imageElements: MeasuredElement[];
  rootRect: Rect;
  scaleX: number;
  scaleY: number;
}) => {
  const entries: Array<DiagnosticEntry | undefined> = new Array(
    assetTargets.length,
  );
  const fallbackTargets: Array<{
    index: number;
    target: SemanticAssetTarget;
  }> = [];
  const claimedElementIndexes = new Set<number>();

  assetTargets.forEach((target, index) => {
    if (target.assetId) {
      const candidates = dataAssetIndex.get(target.assetId) ?? [];
      if (candidates.length === 1) {
        claimedElementIndexes.add(candidates[0]!.index);
        const actual = toModuleRect({
          elementRect: candidates[0]!.rect,
          rootRect,
          scaleX,
          scaleY,
        });
        entries[index] = createMatchedEntry({
          actual,
          assetPath: target.assetPath,
          expected: target.expected,
          kind: "asset",
          match: "data-asset-id",
          targetId: target.targetId,
        });
        return;
      }
      if (candidates.length > 1) {
        entries[index] = createUnmatchedEntry({
          assetPath: target.assetPath,
          candidateCount: candidates.length,
          kind: "asset",
          status: "ambiguous-dom",
          targetId: target.targetId,
        });
        return;
      }
    }

    fallbackTargets.push({ index, target });
  });

  for (const { index, target } of fallbackTargets) {
    const sameRefTargets = fallbackTargets.filter((item) =>
      refsOverlap(item.target.refs, target.refs),
    );
    const candidates = collectImageCandidatesByRefs(
      imageElements,
      target.refs,
      claimedElementIndexes,
    );

    if (sameRefTargets.length > 1 || candidates.length > 1) {
      entries[index] = createUnmatchedEntry({
        assetPath: target.assetPath,
        candidateCount: candidates.length,
        kind: "asset",
        status: "ambiguous-dom",
        targetId: target.targetId,
      });
      continue;
    }
    if (candidates.length === 0) {
      entries[index] = createUnmatchedEntry({
        assetPath: target.assetPath,
        kind: "asset",
        status: "missing-dom",
        targetId: target.targetId,
      });
      continue;
    }

    const candidate = candidates[0]!;
    claimedElementIndexes.add(candidate.index);
    const actual = toModuleRect({
      elementRect: candidate.rect,
      rootRect,
      scaleX,
      scaleY,
    });
    entries[index] = createMatchedEntry({
      actual,
      assetPath: target.assetPath,
      expected: target.expected,
      kind: "asset",
      match: "src",
      targetId: target.targetId,
    });
  }

  return entries.map(
    (entry, index) =>
      entry ??
      createUnmatchedEntry({
        assetPath: assetTargets[index]?.assetPath,
        kind: "asset",
        status: "missing-dom",
        targetId: assetTargets[index]?.targetId ?? `asset:${index + 1}`,
      }),
  );
};

const matchTexts = ({
  dataNodeIndex,
  leafTextElements,
  rootRect,
  scaleX,
  scaleY,
  textTargets,
}: {
  dataNodeIndex: Map<string, MeasuredElement[]>;
  leafTextElements: MeasuredElement[];
  rootRect: Rect;
  scaleX: number;
  scaleY: number;
  textTargets: SemanticTextTarget[];
}) => {
  const entries: Array<DiagnosticEntry | undefined> = new Array(
    textTargets.length,
  );
  const fallbackTargets: Array<{
    index: number;
    target: SemanticTextTarget;
  }> = [];
  const claimedElementIndexes = new Set<number>();

  textTargets.forEach((target, index) => {
    const idCandidates = dataNodeIndex.get(target.targetId) ?? [];
    if (idCandidates.length === 1) {
      claimedElementIndexes.add(idCandidates[0]!.index);
      const actual = toModuleRect({
        elementRect: idCandidates[0]!.rect,
        rootRect,
        scaleX,
        scaleY,
      });
      entries[index] = createMatchedEntry({
        actual,
        expected: target.expected,
        kind: "text",
        match: "data-node-id",
        targetId: target.targetId,
        text: target.text,
      });
      return;
    }
    if (idCandidates.length > 1) {
      entries[index] = createUnmatchedEntry({
        candidateCount: idCandidates.length,
        kind: "text",
        status: "ambiguous-dom",
        targetId: target.targetId,
        text: target.text,
      });
      return;
    }

  fallbackTargets.push({ index, target });
  });

  for (const { index, target } of fallbackTargets) {
    const sameTextTargets = fallbackTargets.filter(
      (item) => item.target.text === target.text,
    );
    const candidates = collectTextCandidatesByContent(
      leafTextElements,
      target.text,
      claimedElementIndexes,
    );

    if (sameTextTargets.length > 1 || candidates.length > 1) {
      entries[index] = createUnmatchedEntry({
        candidateCount: candidates.length,
        kind: "text",
        status: "ambiguous-dom",
        targetId: target.targetId,
        text: target.text,
      });
      continue;
    }
    if (candidates.length === 0) {
      entries[index] = createUnmatchedEntry({
        kind: "text",
        status: "missing-dom",
        targetId: target.targetId,
        text: target.text,
      });
      continue;
    }

    const candidate = candidates[0]!;
    claimedElementIndexes.add(candidate.index);
    const actual = toModuleRect({
      elementRect: candidate.rect,
      rootRect,
      scaleX,
      scaleY,
    });
    entries[index] = createMatchedEntry({
      actual,
      expected: target.expected,
      kind: "text",
      match: "text",
      targetId: target.targetId,
      text: target.text,
    });
  }

  return entries.map(
    (entry, index) =>
      entry ??
      createUnmatchedEntry({
        kind: "text",
        status: "missing-dom",
        targetId: textTargets[index]?.targetId ?? `text:${index + 1}`,
        text: textTargets[index]?.text,
      }),
  );
};

const buildCoordinateWarnings = ({
  measurement,
  scaleX,
  scaleY,
}: {
  measurement: DomMeasurement;
  scaleX: number;
  scaleY: number;
}) => {
  const warnings: string[] = [];
  if (measurement.root.strategy.endsWith("first-ambiguous")) {
    warnings.push(
      `模块根选择存在多个候选，已使用第一个：${measurement.root.strategy} (${measurement.root.candidateCount})`,
    );
  }
  if (measurement.root.strategy === "body-fallback") {
    warnings.push(
      "未找到明确模块根，已使用 document.body 作为坐标原点；actual rect 可能包含宿主偏移。",
    );
  }
  if (
    !Number.isFinite(scaleX) ||
    !Number.isFinite(scaleY) ||
    scaleX <= 0 ||
    scaleY <= 0
  ) {
    warnings.push("模块根尺寸异常，无法可靠反推 CSS transform scale。");
  } else {
    if (scaleX < 0.25 || scaleX > 4 || scaleY < 0.25 || scaleY > 4) {
      warnings.push(
        `模块根 scale 异常：scaleX=${roundMetric(scaleX)}, scaleY=${roundMetric(scaleY)}。`,
      );
    }
    if (Math.abs(scaleX - scaleY) > 0.05) {
      warnings.push(
        `模块根存在非等比缩放：scaleX=${roundMetric(scaleX)}, scaleY=${roundMetric(scaleY)}。`,
      );
    }
  }
  return warnings;
};

const analyzeEntries = ({
  diffRatio,
  entries,
  missingExpected,
}: {
  diffRatio?: number;
  entries: DiagnosticEntry[];
  missingExpected: DiagnosticEntry[];
}) => {
  const allEntries = [...missingExpected, ...entries];
  const actionableIssues = allEntries.filter(
    (entry) => entry.severity !== "ok" || Boolean(entry.status),
  );
  const alignedTargets = entries.filter(
    (entry) => entry.severity === "ok" && !entry.status,
  );
  const unmatchedTargets = allEntries.filter((entry) => Boolean(entry.status));
  const matchedTargets = entries.length - entries.filter((entry) => entry.status).length;
  const missingTargets = unmatchedTargets.filter((entry) =>
    entry.status?.startsWith("missing"),
  ).length;
  const ambiguousTargets = unmatchedTargets.filter(
    (entry) => entry.status === "ambiguous-dom",
  ).length;
  const majorIssues = actionableIssues.filter(
    (entry) => entry.severity === "major",
  ).length;
  const minorIssues = actionableIssues.filter(
    (entry) => entry.severity === "minor",
  ).length;
  const minorEntries = actionableIssues.filter(
    (entry) => entry.severity === "minor",
  );
  const likelyNonActionablePixelDiff =
    typeof diffRatio === "number" &&
    diffRatio >= 0.05 &&
    majorIssues === 0 &&
    missingTargets === 0 &&
    ambiguousTargets === 0 &&
    matchedTargets > 0 &&
    minorIssues / matchedTargets <= 0.15 &&
    minorEntries.every((entry) => (entry.maxDeviation ?? 0) <= 2);

  return {
    actionableIssues,
    alignedTargets,
    ambiguousTargets,
    likelyNonActionablePixelDiff,
    majorIssues,
    matchedTargets,
    minorIssues,
    missingTargets,
    unmatchedTargets,
  };
};

const sortEntry = (entry: DiagnosticEntry) => {
  if (entry.status) return 0;
  if (entry.severity === "major") return 1;
  if (entry.severity === "minor") return 2;
  return 3;
};

const buildReport = ({
  args,
  measurement,
  renderEntry,
  semantic,
}: {
  args: CliArgs;
  measurement: DomMeasurement;
  renderEntry: RenderEntryResolution;
  semantic: SemanticInput;
}) => {
  const rawScaleX = measurement.root.rect.width / semantic.module.width;
  const rawScaleY = measurement.root.rect.height / semantic.module.height;
  const scaleX =
    Number.isFinite(rawScaleX) && rawScaleX > 0 ? rawScaleX : 1;
  const scaleY =
    Number.isFinite(rawScaleY) && rawScaleY > 0 ? rawScaleY : 1;
  const coordinateWarnings = buildCoordinateWarnings({
    measurement,
    scaleX: rawScaleX,
    scaleY: rawScaleY,
  });
  const dataAssetIndex = buildElementIndex(
    measurement.dataAssetElements,
    "dataAssetId",
  );
  const dataNodeIndex = buildElementIndex(
    measurement.dataNodeElements,
    "dataNodeId",
  );

  const assetEntries = matchAssets({
    assetTargets: semantic.assetTargets,
    dataAssetIndex,
    imageElements: measurement.imageElements,
    rootRect: measurement.root.rect,
    scaleX,
    scaleY,
  });
  const textEntries = matchTexts({
    dataNodeIndex,
    leafTextElements: measurement.leafTextElements,
    rootRect: measurement.root.rect,
    scaleX,
    scaleY,
    textTargets: semantic.textTargets,
  });
  const entries = [...assetEntries, ...textEntries].sort(
    (a, b) => sortEntry(a) - sortEntry(b),
  );
  const analysis = analyzeEntries({
    diffRatio: args.diffRatio,
    entries,
    missingExpected: semantic.missingExpected,
  });
  const nonActionableNotes = analysis.likelyNonActionablePixelDiff
    ? [
        "多数可测图片和文本 rect 已对齐；剩余 diff 可能主要来自字体抗锯齿、图片纹理边缘、圆角/阴影边缘或浏览器渲染差异。该提示不代表自动通过，只用于停止无依据布局猜测。",
      ]
    : [];

  return {
    actionableIssues: analysis.actionableIssues,
    alignedTargets: analysis.alignedTargets,
    coordinate: {
      rootCandidateCount: measurement.root.candidateCount,
      rootRect: roundRect(measurement.root.rect),
      rootStrategy: measurement.root.strategy,
      scaleX: roundMetric(scaleX),
      scaleY: roundMetric(scaleY),
      warnings: coordinateWarnings,
    },
    generatedAt: Date.now(),
    imageLoadErrors: measurement.imageLoadErrors,
    moduleId: semantic.module.id,
    nonActionableNotes,
    renderEntry: {
      mode: renderEntry.mode,
      path: renderEntry.path,
      verifyRound: renderEntry.verifyRound,
    },
    summary: {
      alignedTargets: analysis.alignedTargets.length,
      ambiguousTargets: analysis.ambiguousTargets,
      assetTargets: semantic.assetTargets.length,
      likelyNonActionablePixelDiff: analysis.likelyNonActionablePixelDiff,
      majorIssues: analysis.majorIssues,
      matchedTargets: analysis.matchedTargets,
      minorIssues: analysis.minorIssues,
      missingExpectedBoxes: semantic.missingExpected.length,
      missingTargets: analysis.missingTargets,
      pixelDiffRatio: args.diffRatio ?? null,
      textTargets: semantic.textTargets.length,
      unmatchedTargets: analysis.unmatchedTargets.length,
    },
    unmatchedTargets: analysis.unmatchedTargets,
  };
};

const summarizeReport = (
  outputPath: string,
  report: AlignmentDiagnosticsReport,
) => ({
  alignmentDiagnosticsPath: outputPath,
  ...report.summary,
});

const measureModuleAlignment = async (
  input: MeasureModuleAlignmentInput,
): Promise<MeasuredModuleAlignment> => {
  const moduleDir = path.resolve(input.moduleDir);
  const semantic = await readModuleSemantic(moduleDir, input.moduleId);
  const renderEntry = await resolveRenderEntry({
    args: {
      diffRatio: undefined,
      help: false,
      json: false,
      moduleDir,
      moduleId: input.moduleId,
      output: undefined,
      renderEntry: input.renderEntry,
      scale: input.scale,
      verifyRound: input.verifyRound,
    },
    semantic,
  });
  const measurement = await measureDom({
    renderEntryPath: renderEntry.path,
    semantic,
  });
  return {
    measurement,
    moduleDir,
    moduleId: input.moduleId,
    renderEntry,
    scale: input.scale,
    semantic,
  };
};

const writeMeasuredModuleAlignmentDiagnostics = async (
  measured: MeasuredModuleAlignment,
  input: WriteMeasuredModuleAlignmentInput = {},
): Promise<DiagnoseModuleAlignmentResult> => {
  const report = buildReport({
    args: {
      diffRatio: input.diffRatio,
      help: false,
      json: false,
      moduleDir: measured.moduleDir,
      moduleId: measured.moduleId,
      output: input.output,
      renderEntry:
        measured.renderEntry.mode === "explicit"
          ? measured.renderEntry.path
          : undefined,
      scale: measured.scale,
      verifyRound: measured.renderEntry.verifyRound,
    },
    measurement: measured.measurement,
    renderEntry: measured.renderEntry,
    semantic: measured.semantic,
  });
  const outputPath = input.output
    ? path.isAbsolute(input.output)
      ? input.output
      : path.resolve(measured.moduleDir, input.output)
    : path.join(measured.moduleDir, "alignment-diagnostics.json");
  await writeJsonFile(outputPath, report);
  return {
    outputPath,
    report,
    summary: summarizeReport(outputPath, report),
  };
};

const diagnoseModuleAlignment = async (
  input: DiagnoseModuleAlignmentInput,
): Promise<DiagnoseModuleAlignmentResult> => {
  const measured = await measureModuleAlignment(input);
  return writeMeasuredModuleAlignmentDiagnostics(measured, {
    diffRatio: input.diffRatio,
    output: input.output,
  });
};

const parseOptionalNumber = (value: string | undefined, label: string) => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid value for ${label}: ${value}`);
  }
  return parsed;
};

const parseOptionalInteger = (value: string | undefined, label: string) => {
  const parsed = parseOptionalNumber(value, label);
  if (parsed === undefined) return undefined;
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid value for ${label}: ${value}`);
  }
  return parsed;
};

const parseArgs = (args: string[]): CliArgs => {
  const { flags, positionals } = parseCliFlags(args, VALUE_FLAGS);
  const scale = parseOptionalNumber(flags.get("--scale"), "--scale");
  const diffRatio = parseOptionalNumber(
    flags.get("--diff-ratio") ?? flags.get("--diffRatio"),
    "--diff-ratio",
  );
  const verifyRound = parseOptionalInteger(
    flags.get("--verify-round") ??
      flags.get("--verifyRound") ??
      flags.get("--round"),
    "--verify-round",
  );
  if (scale !== undefined && scale <= 0) {
    throw new Error(`Invalid value for --scale: ${scale}`);
  }
  if (diffRatio !== undefined && diffRatio < 0) {
    throw new Error(`Invalid value for --diff-ratio: ${diffRatio}`);
  }
  return {
    diffRatio,
    help: flags.has("--help"),
    json: flags.has("--json"),
    moduleDir:
      flags.get("--module-dir") ??
      flags.get("--moduleDir") ??
      positionals[0] ??
      ".",
    moduleId: flags.get("--module-id") ?? flags.get("--moduleId"),
    output: flags.get("--output"),
    renderEntry: flags.get("--render-entry") ?? flags.get("--renderEntry"),
    scale,
    verifyRound,
  };
};

const buildHelpText = () => `
diagnose-module-alignment — Measure generated asset and text target alignment.

Usage:
  pnpm exec tsx src/cli/diagnose-module-alignment.ts --module-dir <module-dir> --module-id <module-id>
  pnpm exec tsx src/cli/diagnose-module-alignment.ts --module-dir <module-dir> --verify-round <N> --diff-ratio <number>
  pnpm exec tsx src/cli/diagnose-module-alignment.ts --module-dir <module-dir> --render-entry <html>

Options:
  --verify-round <N>   Load module-preview-round-N.html from local verify.
  --render-entry <p>   Explicit HTML entry; use this for framework dist/index.html.
  --diff-ratio <n>     Optional latest verify diffRatio for non-actionable hinting.
  --scale <n>          Optional metadata compatibility; not used for coordinate math.
  --output <p>         Defaults to <module-dir>/alignment-diagnostics.json.
  --json               Print full report to stdout instead of compact summary.
`.trim();

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(buildHelpText());
    return;
  }

  const result = await diagnoseModuleAlignment(args);

  if (args.json) {
    console.log(JSON.stringify(result.report, null, 2));
    return;
  }
  console.log(JSON.stringify(result.summary));
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export {
  diagnoseModuleAlignment,
  measureModuleAlignment,
  writeMeasuredModuleAlignmentDiagnostics,
  type AlignmentDiagnosticsReport,
  type AlignmentDiagnosticsSummary,
};
