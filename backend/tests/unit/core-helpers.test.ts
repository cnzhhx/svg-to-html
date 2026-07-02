import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizeAssetRole } from "../../src/core/asset-role.js";
import {
  areaOf,
  containmentRatio,
  intersectionArea,
  isFiniteBox,
  overlapRatio,
  pointInside,
  unionBoxes,
} from "../../src/core/geometry.js";
import {
  assertOutputFormat,
  getOutputFormatLabel,
  getSourceFragmentFileName,
  normalizeOutputFormat,
  parseOutputFormat,
} from "../../src/core/output-target.js";
import { truncate } from "../../src/core/string-utils.js";
import {
  getCachedInputTokens,
  getUncachedInputTokens,
  normalizeModuleFailureKind,
} from "../../src/pipeline/agent-runner/module/module-pipeline-records.js";
import {
  buildModuleCoordinatorPromptSection,
  buildModuleCoordinatorSubagents,
  resolveModuleAgentCoordinatorDecision,
} from "../../src/pipeline/agent-runner/module/module-agent-coordinator.js";
import {
  isPureTransparentNode,
  readPaintLuminance,
  textColorFromNodePaint,
} from "../../src/pipeline/agent-runner/module/module-semantic-paint.js";
import {
  normalizeVisionNodeSemantic,
  stripJsonMarkdown,
} from "../../src/pipeline/agent-runner/module/module-semantic-vision-normalize.js";
import {
  applyTextEffectLayerSemantics,
  detectTextEffectLayerGroups,
} from "../../src/pipeline/agent-runner/module/module-semantic-text-effects.js";
import {
  deduplicateProbeNodes,
  toProbeNode,
} from "../../src/pipeline/agent-runner/module/module-semantic-probes.js";
import { deduplicateProbeArtifactsByPixels } from "../../src/pipeline/agent-runner/module/module-semantic-probe-pixel-dedup.js";
import {
  readPngAlphaStats,
  readPngRgbaImage,
} from "../../src/pipeline/agent-runner/module/module-semantic-png.js";
import { buildDeterministicSemantic } from "../../src/pipeline/agent-runner/module/module-semantic-deterministic.js";
import {
  buildModuleSemanticTextHints,
  compactDocumentForAgent,
  readModuleAllowedAssets,
  type ModuleSemanticDocument,
  type ModuleSemanticNode,
} from "../../src/pipeline/agent-runner/module/module-semantic.js";
import {
  getExportSvgNodeAssetUsage,
  parseExportSvgNodeAssetArgs,
} from "../../src/cli/export-svg-node-asset-args.js";

test("output format helpers normalize supported formats", () => {
  assert.equal(parseOutputFormat(" Vue "), "vue");
  assert.equal(assertOutputFormat("REACT"), "react");
  assert.equal(normalizeOutputFormat("unknown"), "html");
  assert.equal(getOutputFormatLabel("html"), "HTML");
  assert.equal(getOutputFormatLabel("vue"), "Vue");
  assert.equal(getSourceFragmentFileName("html"), "preview.fragment.html");
  assert.equal(getSourceFragmentFileName("react"), "source.fragment.jsx");
});

test("output format parser rejects unsupported values", () => {
  assert.throws(() => parseOutputFormat("svelte"), /Invalid outputFormat/);
  assert.throws(() => assertOutputFormat(undefined), /Unsupported outputFormat/);
});

test("geometry helpers compute overlap and containment", () => {
  const left = { x: 0, y: 0, width: 10, height: 10 };
  const right = { x: 5, y: 5, width: 10, height: 10 };

  assert.equal(areaOf(left), 100);
  assert.equal(intersectionArea(left, right), 25);
  assert.equal(containmentRatio({ x: 5, y: 5, width: 5, height: 5 }, left), 1);
  assert.equal(overlapRatio(left, right), 0.25);
  assert.equal(pointInside({ x: 10, y: 10 }, left), true);
  assert.equal(pointInside({ x: 11, y: 10 }, left), false);
});

test("geometry helpers validate and union boxes", () => {
  assert.equal(isFiniteBox({ x: 0, y: 0, width: 1, height: 2 }), true);
  assert.equal(isFiniteBox({ x: 0, y: 0, width: Number.NaN, height: 2 }), false);
  assert.deepEqual(
    unionBoxes([
      { x: 5, y: 5, width: 5, height: 5 },
      { x: 0, y: 2, width: 2, height: 3 },
    ]),
    { x: 0, y: 2, width: 10, height: 8 },
  );
  assert.equal(unionBoxes([]), null);
});

test("asset roles collapse synonyms to canonical roles", () => {
  assert.equal(normalizeAssetRole("visual-text"), "atomic-svg-node-visual-text-asset");
  assert.equal(normalizeAssetRole("logo"), "icon-or-illustration");
  assert.equal(normalizeAssetRole("full-page crop"), "layout-shell");
  assert.equal(normalizeAssetRole("source-svg-embedded-raster"), "photo-or-bitmap");
  assert.equal(normalizeAssetRole("badge decoration"), "visual-asset");
  assert.equal(normalizeAssetRole("unknown-role"), undefined);
});

test("truncate handles empty and custom suffix cases", () => {
  assert.equal(truncate("abcdef", 3), "abc...");
  assert.equal(truncate("abcdef", 3, "~"), "abc~");
  assert.equal(truncate("abc", 3), "abc");
  assert.equal(truncate("abcdef", 0), "");
});

test("pipeline record helpers normalize usage and failure kinds", () => {
  assert.equal(
    normalizeModuleFailureKind("module_framework_failed"),
    "module_framework_failed",
  );
  assert.equal(normalizeModuleFailureKind("nope"), "merge_failed");
  assert.equal(getCachedInputTokens({ input_tokens: 20, cached_input_tokens: 7 }), 7);
  assert.equal(getUncachedInputTokens({ input_tokens: 20, cached_input_tokens: 7 }), 13);
  assert.equal(getUncachedInputTokens(null), 0);
});

test("module coordinator triggers on node count or json size", () => {
  const config = {
    enabled: true,
    jsonBytesThreshold: 35 * 1024,
    nodeThreshold: 50,
  };
  const makeSemantic = (nodeCount: number) => ({
    nodes: Array.from({ length: nodeCount }, (_, index) => ({ id: `n${index}` })),
  });

  assert.deepEqual(
    resolveModuleAgentCoordinatorDecision({
      config,
      jsonBytes: 1000,
      moduleSemantic: makeSemantic(50),
    }),
    {
      enabled: true,
      jsonBytes: 1000,
      jsonBytesThreshold: 35840,
      nodeCount: 50,
      nodeThreshold: 50,
      reason: "nodes",
    },
  );
  assert.equal(
    resolveModuleAgentCoordinatorDecision({
      config,
      jsonBytes: 35 * 1024,
      moduleSemantic: makeSemantic(1),
    }).reason,
    "json-bytes",
  );
  assert.equal(
    resolveModuleAgentCoordinatorDecision({
      config,
      jsonBytes: 1000,
      moduleSemantic: makeSemantic(49),
    }).enabled,
    false,
  );
  assert.equal(
    resolveModuleAgentCoordinatorDecision({
      config: { ...config, enabled: false },
      jsonBytes: 100_000,
      moduleSemantic: makeSemantic(100),
    }).reason,
    "disabled",
  );
});

test("module coordinator subagents are read-only and non-recursive", () => {
  const agents = buildModuleCoordinatorSubagents();
  assert.deepEqual(Object.keys(agents ?? {}).sort(), ["module-analysis"]);

  for (const agent of Object.values(agents ?? {})) {
    assert.equal(agent.mode, "subagent");
    assert.equal(agent.steps, 6);
    assert.equal(agent.tools?.read, true);
    assert.equal(agent.tools?.glob, true);
    assert.equal(agent.tools?.grep, true);
    assert.equal(agent.tools?.task, false);
    assert.equal(agent.tools?.edit, false);
    assert.equal(agent.tools?.write, false);
    assert.equal(agent.tools?.bash, false);
    assert.equal(agent.tools?.webfetch, false);
    assert.equal(agent.tools?.websearch, false);
  }
});

test("module coordinator prompt section is only emitted when enabled", () => {
  const disabled = resolveModuleAgentCoordinatorDecision({
    config: {
      enabled: true,
      jsonBytesThreshold: 35 * 1024,
      nodeThreshold: 50,
    },
    jsonBytes: 1000,
    moduleSemantic: { nodes: [] },
  });
  assert.equal(buildModuleCoordinatorPromptSection(disabled), "");

  const enabled = resolveModuleAgentCoordinatorDecision({
    config: {
      enabled: true,
      jsonBytesThreshold: 35 * 1024,
      nodeThreshold: 50,
    },
    jsonBytes: 36 * 1024,
    moduleSemantic: { nodes: [] },
  });
  const section = buildModuleCoordinatorPromptSection(enabled);
  assert.match(section, /coordinator planning phase/);
  assert.match(section, /这不是固定拆法/);
  assert.match(section, /subagent 不会带来收益，可以不用/);
  assert.match(section, /module-analysis/);
  assert.match(section, /Task 工具/);
  assert.doesNotMatch(section, /module-structure/);
  assert.doesNotMatch(section, /module-assets/);
  assert.doesNotMatch(section, /module-text/);
});

test("semantic paint helpers preserve text color and transparency rules", () => {
  const baseNode: ModuleSemanticNode = {
    attrs: {},
    childIds: [],
    depth: 1,
    id: "node-1",
    inspectIndex: 1,
    nodePath: "svg > path",
    parentId: null,
    semantic: {
      containsReadableText: false,
      exportDecision: "pending",
      kind: "unknown",
      textHandling: "pending",
    },
    siblingIndex: 0,
    tag: "path",
    visible: true,
  };

  assert.equal(
    textColorFromNodePaint({
      ...baseNode,
      attrs: { fill: "#336699", "fill-opacity": "0.5", opacity: "0.5" },
      tag: "text",
    }),
    "rgba(51, 102, 153, 0.25)",
  );
  assert.equal(readPaintLuminance("white"), 1);
  assert.equal(readPaintLuminance("rgb(0, 0, 0)"), 0);
  assert.equal(
    isPureTransparentNode({
      ...baseNode,
      attrs: { fill: "none", stroke: "rgba(0, 0, 0, 0.02)" },
    }),
    true,
  );
  assert.equal(
    isPureTransparentNode({
      ...baseNode,
      attrs: { fill: "transparent", stroke: "transparent" },
      tag: "text",
    }),
    false,
  );
});

test("semantic text hints preserve node paint opacity", () => {
  const node: ModuleSemanticNode = {
    attrs: { fill: "#6C6F7E", opacity: "0.8" },
    bbox: { x: 32.528, y: 0.914, width: 616.994, height: 140.548 },
    childIds: [],
    depth: 2,
    id: "n0007",
    inspectIndex: 6,
    nodePath: "svg > g > path",
    parentId: "n0006",
    semantic: {
      containsReadableText: true,
      exportDecision: "skip",
      kind: "text",
      text: "活动说明：",
      textHandling: "dom-text",
    },
    siblingIndex: 0,
    tag: "path",
    visible: true,
  };
  const document = {
    analysisSheets: [],
    generatedAssets: [],
    module: {
      id: "module-04",
      kind: "section",
      region: { x: 0, y: 0, width: 750, height: 196 },
      scale: 2,
    },
    nodes: [node],
    runtime: {
      completedStages: [],
      nodeFactVersion: 1,
    },
    sourceImage: {
      height: 196,
      id: "module-reference",
      path: "module-reference.png",
      readableByAgent: true,
      width: 750,
    },
    svgSummary: {
      hasContextSvg: false,
      height: 196,
      imageCount: 0,
      maskOrClipCount: 0,
      pathCount: 1,
      rootAttrs: {},
      width: 750,
    },
    textBlocks: [
      {
        id: "n0007",
        kind: "text",
        sourceNodeIds: ["n0007"],
        text: "活动说明：",
        textRegion: node.bbox,
      },
    ],
  } satisfies ModuleSemanticDocument;

  assert.deepEqual(buildModuleSemanticTextHints(document).blocks, [
    {
      bbox: node.bbox,
      color: "rgba(108, 111, 126, 0.8)",
      id: "n0007",
      lineCount: undefined,
      lines: undefined,
      role: "text",
      text: "活动说明：",
    },
  ]);
});

test("agent semantic compaction removes duplicate fields but preserves asset compatibility", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "semantic-compact-"));
  try {
    const textNode: ModuleSemanticNode = {
      attrs: { fill: "#A1A1A1" },
      bbox: { x: 10, y: 20, width: 80, height: 16 },
      childIds: [],
      depth: 1,
      id: "text-1",
      inspectIndex: 2,
      nodePath: "svg > path:nth-of-type(1)",
      parentId: null,
      semantic: {
        containsReadableText: true,
        contentType: "unknown",
        exportDecision: "skip",
        kind: "text",
        text: "Hello",
        textHandling: "dom-text",
      },
      siblingIndex: 0,
      tag: "path",
      visible: true,
    };
    const visualTextNode: ModuleSemanticNode = {
      ...textNode,
      id: "visual-text-1",
      inspectIndex: 3,
      semantic: {
        containsReadableText: true,
        exportDecision: "export",
        kind: "visual-text",
        text: "Logo",
        textHandling: "export-asset",
      },
    };
    const document: ModuleSemanticDocument = {
      analysisSheets: [],
      generatedAssets: [
        {
          assetRole: "visual-asset",
          box: { x: 1, y: 2, width: 30, height: 40 },
          htmlRef: "assets/a.png",
          id: "module-x:a",
          path: "assets/a.png",
          readableByAgent: true,
          relativePath: "assets/a.png",
          source: "module-agent.export-svg-node-asset",
          sourceNodeIds: ["visual-text-1"],
          sourceNodePaths: ["svg > path:nth-of-type(2)"],
          textTreatment: "no-preprocessed-text",
        },
      ],
      module: {
        id: "module-x",
        kind: "section",
        region: { x: 0, y: 0, width: 100, height: 100 },
        scale: 1,
      },
      nodes: [textNode, visualTextNode],
      runtime: {
        completedStages: [],
        nodeFactVersion: 1,
        referenceRenderVersion: 1,
        schemaVersion: 1,
        semanticPassVersion: 1,
        textStylePassVersion: 1,
      },
      sourceImage: {
        height: 100,
        id: "module-reference",
        path: "module-reference.png",
        readableByAgent: true,
        width: 100,
      },
      svgSummary: {
        nodeCount: 2,
        rootAttrs: {},
        tagCounts: { path: 2 },
        textNodeCount: 0,
        visibleNodeCount: 2,
      },
      textBlocks: [
        {
          color: "#A1A1A1",
          id: "text-1",
          sourceNodeIds: ["text-1"],
          styleInference: {
            color: "#A1A1A1",
            "font-size": "13px",
          },
          text: "Hello",
          textRegion: textNode.bbox!,
        },
      ],
    };

    const compacted = compactDocumentForAgent(document);
    const compactTextNode = compacted.nodes.find((node) => node.id === "text-1");
    const compactVisualTextNode = compacted.nodes.find(
      (node) => node.id === "visual-text-1",
    );
    assert.ok(compactTextNode);
    assert.ok(compactVisualTextNode);
    assert.equal(compactTextNode.semantic.text, undefined);
    assert.equal(compactTextNode.semantic.containsReadableText, undefined);
    assert.equal(compactTextNode.semantic.contentType, undefined);
    assert.equal(compactVisualTextNode.semantic.text, "Logo");
    assert.equal(compacted.textBlocks[0]?.color, undefined);
    assert.deepEqual(compacted.generatedAssets[0], {
      box: { x: 1, y: 2, width: 30, height: 40 },
      id: "module-x:a",
      path: "assets/a.png",
      sourceNodeIds: ["visual-text-1"],
    });

    await writeFile(
      path.join(tempDir, "module-semantic.json"),
      JSON.stringify(compacted),
      "utf8",
    );
    const allowedAssets = await readModuleAllowedAssets(tempDir);
    assert.equal(allowedAssets[0]?.htmlRef, "assets/a.png");
    assert.equal(allowedAssets[0]?.path, "assets/a.png");
    assert.equal(allowedAssets[0]?.relativePath, "assets/a.png");
    assert.equal(allowedAssets[0]?.textTreatment, "unknown");
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("semantic deterministic helper classifies obvious node cases", () => {
  const makeNode = (
    overrides: Partial<ModuleSemanticNode>,
  ): ModuleSemanticNode => ({
    attrs: {},
    bbox: { x: 0, y: 0, width: 100, height: 20 },
    childIds: [],
    depth: 1,
    id: "node",
    inspectIndex: 1,
    nodePath: "svg > path",
    parentId: null,
    semantic: {
      containsReadableText: false,
      exportDecision: "pending",
      kind: "unknown",
      textHandling: "pending",
    },
    siblingIndex: 0,
    tag: "path",
    visible: true,
    ...overrides,
  });

  assert.equal(buildDeterministicSemantic(makeNode({ depth: 0 }))?.kind, "container");
  assert.deepEqual(
    buildDeterministicSemantic(
      makeNode({
        attrs: { mask: "url(#clip)" },
        childIds: ["child"],
        tag: "g",
      }),
    ),
    {
      confidence: 1,
      containsReadableText: false,
      exportDecision: "export",
      kind: "visual-context-wrapper",
      notes: "container has mask/clip/filter context that affects descendant rendering; export wrapper to preserve visual context",
      textHandling: "ignore",
    },
  );
  assert.equal(
    buildDeterministicSemantic(
      makeNode({ tag: "text", textContent: "Hello" }),
    )?.textHandling,
    "dom-text",
  );
  assert.equal(
    buildDeterministicSemantic(
      makeNode({ bbox: { x: 0, y: 0, width: 3, height: 20 } }),
    )?.kind,
    "decoration",
  );
  assert.equal(
    buildDeterministicSemantic(
      makeNode({ attrs: { pathDataLength: "10" } }),
    )?.kind,
    "shape",
  );
});

test("semantic vision normalization strips wrappers and handles text semantics", () => {
  assert.equal(
    stripJsonMarkdown("<think>hidden</think>```json\n[{\"id\":\"a\"}]\n```"),
    "[{\"id\":\"a\"}]",
  );

  assert.deepEqual(
    normalizeVisionNodeSemantic({
      contentType: "badge",
      isPureText: true,
      lineCount: 1.4,
      text: "  Hello   world ",
      visualLines: [" Hello ", " world "],
    }),
    {
      containsReadableText: true,
      contentType: "badge",
      exportDecision: "skip",
      kind: "text",
      lineCount: 1,
      text: "Hello\nworld",
      textHandling: "dom-text",
      visualLines: ["Hello", "world"],
    },
  );

  const missingText = normalizeVisionNodeSemantic({
    contentType: "not-valid",
    isPureText: true,
  });
  assert.equal(missingText.contentType, "unknown");
  assert.equal(missingText.exportDecision, "export");
  assert.equal(missingText.textHandling, "ignore");
});

test("semantic text effect helpers detect grouped masked text layers", () => {
  const semantic = {
    containsReadableText: false,
    exportDecision: "pending",
    kind: "unknown",
    textHandling: "pending",
  } as const;
  const nodes: ModuleSemanticNode[] = [
    {
      attrs: {},
      childIds: ["fill", "effect"],
      depth: 1,
      id: "group",
      inspectIndex: 1,
      nodePath: "svg > g",
      parentId: null,
      semantic,
      siblingIndex: 0,
      tag: "g",
      visible: true,
    },
    {
      attrs: { pathDataLength: "100" },
      bbox: { x: 0, y: 0, width: 100, height: 20 },
      childIds: [],
      depth: 2,
      id: "fill",
      inspectIndex: 2,
      nodePath: "svg > g > path[1]",
      parentId: "group",
      semantic,
      siblingIndex: 0,
      tag: "path",
      visible: true,
    },
    {
      attrs: { mask: "url(#outside-stroke)", pathDataLength: "400" },
      bbox: { x: 1, y: 0, width: 100, height: 20 },
      childIds: [],
      depth: 2,
      id: "effect",
      inspectIndex: 3,
      nodePath: "svg > g > path[2]",
      parentId: "group",
      semantic,
      siblingIndex: 1,
      tag: "path",
      visible: true,
    },
  ];

  const groups = detectTextEffectLayerGroups(nodes);
  assert.deepEqual(groups, [
    {
      effectNodeIds: ["effect"],
      effectType: "outside-stroke",
      fillNodeId: "fill",
      parentId: "group",
    },
  ]);

  const deterministicById = new Map();
  assert.equal(
    applyTextEffectLayerSemantics(groups, deterministicById, nodes),
    3,
  );
  assert.equal(deterministicById.get("group")?.kind, "text-effect-group");
  assert.equal(deterministicById.get("fill")?.exportDecision, "skip");
  assert.equal(deterministicById.get("effect")?.kind, "text-effect-layer");
});

test("semantic probe helpers deduplicate visual-equivalent non-image nodes", () => {
  const makeNode = (
    id: string,
    attrs: ModuleSemanticNode["attrs"],
    tag = "path",
  ): ModuleSemanticNode => ({
    attrs,
    bbox: { x: id === "b" ? 20 : 0, y: 0, width: 10, height: 5 },
    childIds: [],
    depth: 1,
    id,
    inspectIndex: 1,
    nodePath: `svg > ${tag}`,
    parentId: null,
    selector: `#${id}`,
    semantic: {
      containsReadableText: false,
      exportDecision: "pending",
      kind: "unknown",
      textHandling: "pending",
    },
    siblingIndex: 0,
    tag,
    visible: true,
  });
  const probes = [
    toProbeNode(makeNode("a", { fill: "#111", pathDataLength: "20" })),
    toProbeNode(makeNode("b", { fill: "#111", pathDataLength: "20" })),
    toProbeNode(makeNode("photo-a", { href: "x.png" }, "image")),
    toProbeNode(makeNode("photo-b", { href: "x.png" }, "image")),
  ].filter((node): node is NonNullable<typeof node> => Boolean(node));

  const { deduplicated, duplicateToRepresentative } =
    deduplicateProbeNodes(probes);

  assert.deepEqual(
    deduplicated.map((node) => node.id),
    ["a", "photo-a", "photo-b"],
  );
  assert.equal(duplicateToRepresentative.get("b"), "a");
  assert.equal(duplicateToRepresentative.has("photo-b"), false);
});

test("semantic png helper reads alpha visibility stats", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "semantic-png-"));
  try {
    const transparentPath = path.join(tempDir, "transparent.png");
    const visiblePath = path.join(tempDir, "visible.png");
    const rgbPath = path.join(tempDir, "rgb.png");
    await writeFile(
      transparentPath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DAAAAEAQEARwbK3gAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    await writeFile(
      visiblePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    await writeFile(
      rgbPath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
        "base64",
      ),
    );

    assert.deepEqual(await readPngAlphaStats(transparentPath), {
      averageLuminance: undefined,
      hasAlpha: true,
      visiblePixelCount: 0,
    });
    assert.deepEqual(await readPngAlphaStats(visiblePath), {
      averageLuminance: 0.2126,
      hasAlpha: true,
      visiblePixelCount: 1,
    });
    assert.deepEqual(await readPngAlphaStats(rgbPath), {
      hasAlpha: false,
      visiblePixelCount: 1,
    });
    const visibleImage = await readPngRgbaImage(visiblePath);
    assert.equal(visibleImage?.width, 1);
    assert.equal(visibleImage?.height, 1);
    assert.equal(visibleImage?.hasAlpha, true);
    assert.deepEqual(
      visibleImage ? Array.from(visibleImage.data) : [],
      [255, 0, 0, 255],
    );
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("semantic probe pixel helper deduplicates rendered-equivalent probes", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "semantic-probe-pixel-"));
  try {
    const redPath = path.join(tempDir, "red.png");
    const redCopyPath = path.join(tempDir, "red-copy.png");
    const transparentPath = path.join(tempDir, "transparent.png");
    const redPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
      "base64",
    );
    await writeFile(redPath, redPng);
    await writeFile(redCopyPath, redPng);
    await writeFile(
      transparentPath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DAAAAEAQEARwbK3gAAAABJRU5ErkJggg==",
        "base64",
      ),
    );

    const makeProbe = (id: string, outputPath: string) => {
      const probe = toProbeNode({
        attrs: { fill: "#f00", pathDataLength: "10" },
        bbox: { x: id === "red-copy" ? 10 : 0, y: 0, width: 1, height: 1 },
        childIds: [],
        depth: 1,
        id,
        inspectIndex: 1,
        nodePath: `svg > path#${id}`,
        parentId: null,
        selector: `#${id}`,
        semantic: {
          containsReadableText: false,
          exportDecision: "pending",
          kind: "unknown",
          textHandling: "pending",
        },
        siblingIndex: 0,
        tag: "path",
        visible: true,
      });
      assert.ok(probe);
      return {
        node: probe,
        outputPath,
      };
    };

    const result = await deduplicateProbeArtifactsByPixels([
      makeProbe("red", redPath),
      makeProbe("red-copy", redCopyPath),
      makeProbe("transparent", transparentPath),
    ]);

    assert.deepEqual(
      result.deduplicatedArtifacts.map((artifact) => artifact.node.id),
      ["red", "transparent"],
    );
    assert.equal(result.duplicateToRepresentative.get("red-copy"), "red");
    assert.equal(result.duplicateToRepresentative.has("transparent"), false);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("export svg node asset args preserve selection and validation behavior", () => {
  assert.deepEqual(
    parseExportSvgNodeAssetArgs([
      "--module-dir",
      "module-a",
      "--node-id",
      "n1,n2",
      "--node-id=n3",
      "--output",
      "assets/x.png",
      "--allow-text=true",
      "--register-semantic",
      "--padding",
      "2",
      "--scale=1.5",
    ]),
    {
      allowText: true,
      assetRole: undefined,
      elementIndex: undefined,
      help: false,
      moduleDir: "module-a",
      moduleSvg: "module.svg",
      nodeIds: ["n1", "n2", "n3"],
      noRegisterSemantic: false,
      output: "assets/x.png",
      padding: 2,
      registerSemantic: true,
      scale: 1.5,
      selector: undefined,
      textTreatment: undefined,
    },
  );
  assert.throws(
    () =>
      parseExportSvgNodeAssetArgs([
        "--index",
        "1",
        "--selector",
        "#a",
        "--output",
        "x.png",
      ]),
    /Provide exactly one/,
  );
  assert.deepEqual(
    parseExportSvgNodeAssetArgs([
      "--module-dir",
      "module-a",
      "--node-id",
      "n1",
      "--output",
      "assets/x.png",
      "--no-register-semantic",
    ]),
    {
      allowText: false,
      assetRole: undefined,
      elementIndex: undefined,
      help: false,
      moduleDir: "module-a",
      moduleSvg: "module.svg",
      nodeIds: ["n1"],
      noRegisterSemantic: true,
      output: "assets/x.png",
      padding: 0,
      registerSemantic: false,
      scale: 1,
      selector: undefined,
      textTreatment: undefined,
    },
  );
  assert.throws(
    () =>
      parseExportSvgNodeAssetArgs([
        "--node-id",
        "n1",
        "--output",
        "x.png",
        "--register-semantic",
        "--no-register-semantic",
      ]),
    /at most one/,
  );
  assert.throws(
    () =>
      parseExportSvgNodeAssetArgs([
        "--index",
        "1",
        "--output",
        "x.png",
        "--allow-text=false",
      ]),
    /--allow-text does not take a value/,
  );
  assert.match(getExportSvgNodeAssetUsage(), /export-svg-node-asset/);
});
