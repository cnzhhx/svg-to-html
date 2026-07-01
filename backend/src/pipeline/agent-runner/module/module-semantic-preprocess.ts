import {
  createModuleTextBlocks,
  type ModuleTextBlocksFile,
} from "../../../core/module-text-blocks.js";
import type { ResolvedDesignTarget } from "../../../core/design-resolve.js";
import type { SvgVerticalModule } from "../../../core/svg-vertical-modules/types.js";
import { isRecord } from "../../../core/type-guards.js";
import {
  buildModuleSemanticTextHints,
  readModuleSemanticDocument,
  type ModuleSemanticDocument,
} from "./module-semantic.js";
import { writeModuleSemanticPayload } from "./module-semantic-payload.js";
import { analyzeModuleElements } from "./module-semantic-pass.js";
import {
  createModuleTextStyleHints,
  type ModuleTextStyleHintsFile,
} from "./module-text-style-inference.js";
import { textColorFromNodePaint } from "./module-semantic-paint.js";
import { Semaphore } from "../queue/concurrency.js";
import { throwIfRunAborted } from "../session/run-control.js";

class ModuleInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModuleInputError";
  }
}

const TEXT_PAINT_OPACITY_STAGE = "text-paint-opacity-v2";

const SEMITRANSPARENT_COLOR_RE =
  /^rgba\(\s*[^,]+\s*,\s*[^,]+\s*,\s*[^,]+\s*,\s*(0(?:\.\d+)?|1\.0+)\s*\)$/i;

const isSemitransparentColor = (value: string | undefined) => {
  const match = value?.trim().match(SEMITRANSPARENT_COLOR_RE);
  if (!match) return false;
  const alpha = Number(match[1]);
  return Number.isFinite(alpha) && alpha >= 0 && alpha < 0.999;
};

const buildTextNodeColorById = (document: ModuleSemanticDocument) =>
  new Map(
    document.nodes.flatMap((node) => {
      const color = node.attrs ? textColorFromNodePaint(node) : undefined;
      return color ? [[node.id, color] as const] : [];
    }),
  );

const resolveTextBlockColor = ({
  block,
  nodeColorById,
}: {
  block: ModuleSemanticDocument["textBlocks"][number];
  nodeColorById: Map<string, string>;
}) => {
  const nodeColor = nodeColorById.get(block.id);
  const blockColor = typeof block.color === "string" && block.color.trim().length > 0
    ? block.color.trim()
    : undefined;
  if (isSemitransparentColor(nodeColor)) return nodeColor;
  if (isSemitransparentColor(blockColor)) return blockColor;
  return nodeColor ?? blockColor;
};

const buildTextBlocksFileFromSemantic = (
  document: ModuleSemanticDocument,
): ModuleTextBlocksFile => {
  const nodeColorById = buildTextNodeColorById(document);
  return {
    blockCount: document.textBlocks.length,
    blocks: document.textBlocks.map((block) => ({
      bboxIncludesIcon:
        typeof block.bboxIncludesIcon === "boolean"
          ? block.bboxIncludesIcon
          : undefined,
      color: resolveTextBlockColor({ block, nodeColorById }),
      confidence:
        typeof block.confidence === "number" ? block.confidence : undefined,
      id: block.id,
      kind: typeof block.kind === "string" ? block.kind : undefined,
      lineCount:
        typeof block.lineCount === "number" && Number.isFinite(block.lineCount)
          ? Math.round(block.lineCount)
          : undefined,
      lineRegions: Array.isArray(block.lineRegions) ? block.lineRegions : undefined,
      lines: Array.isArray(block.lines) ? block.lines : undefined,
      region: isRecord(block.region)
        ? (block.region as ModuleTextBlocksFile["blocks"][number]["region"])
        : block.textRegion,
      renderedTextRegion: isRecord(block.renderedTextRegion)
        ? (block.renderedTextRegion as ModuleTextBlocksFile["blocks"][number]["renderedTextRegion"])
        : undefined,
      source: typeof block.source === "string" ? (block.source as "semantic") : undefined,
      sourceBlockId:
        typeof block.sourceBlockId === "string" ? block.sourceBlockId : undefined,
      sourceBlockText:
        typeof block.sourceBlockText === "string" ? block.sourceBlockText : undefined,
      text: block.text,
      textRegion: block.textRegion,
    })),
    coordinateSpace: "local",
    generatedAt: new Date().toISOString(),
    generatedBy: "semantic-text-extract",
    moduleId: document.module.id,
    previewPath: document.sourceImage.path,
    region: document.module.region,
  };
};

const buildTextStyleHintsFileFromSemantic = (
  document: ModuleSemanticDocument,
): ModuleTextStyleHintsFile => {
  const normalizeFit = (value: unknown) => {
    if (!isRecord(value)) {
      return { heightDelta: 0, score: 0, widthDelta: 0 };
    }
    return {
      heightDelta:
        typeof value.heightDelta === "number" ? value.heightDelta : 0,
      score: typeof value.score === "number" ? value.score : 0,
      ...(typeof value.visualDensityDelta === "number"
        ? { visualDensityDelta: value.visualDensityDelta }
        : {}),
      ...(typeof value.visualIou === "number"
        ? { visualIou: value.visualIou }
        : {}),
      widthDelta: typeof value.widthDelta === "number" ? value.widthDelta : 0,
    };
  };
  const rawDocument = document as Record<string, unknown>;
  const nodeColorById = buildTextNodeColorById(document);
  const textAppearanceHints = Array.isArray(rawDocument["textAppearanceHints"])
    ? rawDocument["textAppearanceHints"].filter(isRecord)
    : [];
  const hintsById = new Map(
    textAppearanceHints.flatMap((item) => {
      const id = typeof item.id === "string" ? item.id : undefined;
      if (!id) return [];
      const declarations = isRecord(item.declarations)
        ? (Object.fromEntries(
            Object.entries(item.declarations).filter(
              ([, value]) => typeof value === "string",
            ),
          ) as Record<string, string>)
        : {};
      return [
        [
          id,
          {
            declarations,
            fit: normalizeFit(item.fit),
            kind: typeof item.kind === "string" ? item.kind : undefined,
            region: isRecord(item.region) ? item.region : undefined,
            text: typeof item.text === "string" ? item.text : undefined,
          },
        ] as const,
      ];
    }),
  );

  const blocks = document.textBlocks.flatMap((block) => {
    const semanticHint = hintsById.get(block.id);
    const declarations: Record<string, string> =
      semanticHint?.declarations ??
      (isRecord(block.styleInference)
        ? (Object.fromEntries(
            Object.entries(block.styleInference).filter(
              ([, value]) => typeof value === "string",
            ),
          ) as Record<string, string>)
        : {});
    const color = resolveTextBlockColor({ block, nodeColorById });
    if (color) {
      declarations.color = color;
    }
    if (Object.keys(declarations).length === 0) return [];
    return [
      {
        confidence:
          typeof block.confidence === "number" ? block.confidence : undefined,
        declarations,
        fit: semanticHint?.fit ?? normalizeFit(undefined),
        id: block.id,
        kind:
          semanticHint?.kind ??
          (typeof block.kind === "string" ? block.kind : undefined),
        lineCount:
          typeof block.lineCount === "number" && Number.isFinite(block.lineCount)
            ? Math.round(block.lineCount)
            : undefined,
        lineRegions: Array.isArray(block.lineRegions) ? block.lineRegions : undefined,
        region: block.textRegion,
        text: semanticHint?.text ?? block.text,
      },
    ];
  });

  return {
    blockCount: blocks.length,
    blocks,
    generatedAt: new Date().toISOString(),
    generatedBy: "text-style-inference",
    moduleId: document.module.id,
    previewPath: document.sourceImage.path,
  };
};

const preprocessModuleSemantic = async ({
  controller,
  design,
  module,
  moduleDir,
  moduleSvgPath,
  sessionId,
  visionSemaphore,
}: {
  controller: AbortController;
  design: ResolvedDesignTarget;
  module: SvgVerticalModule;
  moduleDir: string;
  moduleSvgPath: string;
  sessionId: string;
  visionSemaphore: Semaphore;
}) => {
  const elementAnalysis = await analyzeModuleElements({
    module,
    moduleDir,
    scale: design.scale,
    signal: controller.signal,
    sessionId,
    visionSemaphore,
  });
  throwIfRunAborted(controller);
  const currentSemantic = await readModuleSemanticDocument(moduleDir);
  if (!currentSemantic) {
    throw new Error(`module-semantic.json missing after semantic pass: ${module.id}`);
  }

  const hasCachedTextArtifacts =
    currentSemantic.runtime.completedStages.includes("text-blocks") &&
    currentSemantic.runtime.completedStages.includes("text-style-inference") &&
    currentSemantic.runtime.completedStages.includes(TEXT_PAINT_OPACITY_STAGE) &&
    currentSemantic.textBlocks.length > 0;

  const semanticTextHints = buildModuleSemanticTextHints(currentSemantic);
  const textBlocksFile = hasCachedTextArtifacts
    ? buildTextBlocksFileFromSemantic(currentSemantic)
    : await createModuleTextBlocks({
        moduleDir,
        moduleId: module.id,
        textHints: semanticTextHints,
        moduleSvgPath,
        region: module.region,
        scale: design.scale,
      });
  const textStyleHintsFile = hasCachedTextArtifacts
    ? buildTextStyleHintsFileFromSemantic(currentSemantic)
    : await createModuleTextStyleHints({
        moduleDir,
        moduleId: module.id,
        scale: design.scale,
        textBlocksFile,
      });

  const moduleSemantic = await writeModuleSemanticPayload({
    allowedAssets: currentSemantic.generatedAssets,
    basePayload: currentSemantic as unknown as Record<string, unknown>,
    elementAnalysis,
    module,
    moduleDir,
    textHints: semanticTextHints,
    moduleTextBlocks: textBlocksFile,
    moduleTextStyleHints: textStyleHintsFile,
    moduleSvgPath,
    scale: design.scale,
  });

  return {
    elementAnalysis,
    moduleSemantic,
    initialAgentGeneratedAssetCount: currentSemantic.generatedAssets.length,
    textBlocksFile,
    textStyleHintsFile,
  };
};

const readAgentGeneratedAssetCount = async (moduleDir: string) =>
  (await readModuleSemanticDocument(moduleDir))?.generatedAssets.length ?? 0;

const SEMANTIC_CONTAINER_TAGS = new Set([
  "a",
  "defs",
  "desc",
  "g",
  "metadata",
  "svg",
  "switch",
  "symbol",
  "title",
]);

const moduleHasDeclaredSourceContent = (module: SvgVerticalModule) =>
  module.sourceContainerIds.length > 0 ||
  module.nodePaths.length > 0 ||
  module.candidateNodeCount > 0;

const semanticNodeCarriesUsableVisual = (
  node: ModuleSemanticDocument["nodes"][number],
) => {
  if (node.visible === false) return false;
  const tag = node.tag.trim().toLowerCase();
  if (SEMANTIC_CONTAINER_TAGS.has(tag)) return false;
  if (node.bbox && node.bbox.width > 0 && node.bbox.height > 0) return true;
  if (node.textContent?.trim()) return true;
  return node.semantic.exportDecision !== "skip";
};

const assertModuleSemanticHasUsableInput = ({
  module,
  moduleSemantic,
  textBlockCount,
}: {
  module: SvgVerticalModule;
  moduleSemantic: ModuleSemanticDocument;
  textBlockCount: number;
}) => {
  if (!moduleHasDeclaredSourceContent(module)) return;
  const hasTextBlocks = textBlockCount > 0;
  const hasUsableVisibleNodes = moduleSemantic.nodes.some(
    semanticNodeCarriesUsableVisual,
  );
  if (hasTextBlocks || hasUsableVisibleNodes) return;

  throw new ModuleInputError(
    `module input has source ownership markers but semantic preprocessing produced no usable text blocks or visible source nodes`,
  );
};

export {
  assertModuleSemanticHasUsableInput,
  ModuleInputError,
  preprocessModuleSemantic,
  readAgentGeneratedAssetCount,
};
