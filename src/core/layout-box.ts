import { readFile } from "node:fs/promises";
import path from "node:path";

import { evaluatePage, launchEdge } from "./cdp.js";
import startStaticServer from "./static-server.js";
import {
  extractInlineConfig,
  hasInlineConfig,
  type TextLayoutConfig,
} from "./text-layout.js";
import {
  resolveDesignPair,
  resolveSvgDesign,
  toAbsolutePath,
  toUrlPath,
  writeJsonFile,
  writeTextFile,
} from "./utils.js";

type BlockResult = {
  deltaHeight: number | null;
  deltaWidth: number | null;
  deltaX: number | null;
  deltaY: number | null;
  expectedBox: null | {
    height: number;
    width: number;
    x: number;
    y: number;
  };
  htmlBox: null | {
    height: number;
    width: number;
    x: number;
    y: number;
  };
  id: string;
  selector: string;
  selectorCandidates?: string[];
};

const formatDelta = (value: number | null) =>
  value === null ? "n/a" : `${value}px`;

const readTrackedBlocks = ({
  blockArg,
  config,
}: {
  blockArg?: string;
  config: TextLayoutConfig;
}) => {
  const selectedIds = blockArg
    ? blockArg
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : (config.blocks?.map((item) => item.id) ?? []);

  return (config.blocks ?? []).filter((item) => selectedIds.includes(item.id));
};

const createLayoutBoxReport = async ({
  artifactDir,
  blockArg,
  htmlPath,
  inputPath,
  scale,
}: {
  artifactDir: string;
  blockArg?: string;
  htmlPath?: string;
  inputPath: string;
  scale?: number;
}) => {
  const resolvedDesign = htmlPath
    ? await resolveSvgDesign(inputPath, { scale })
    : await resolveDesignPair(inputPath, { scale });
  const design = htmlPath
    ? {
        ...resolvedDesign,
        htmlPath: toAbsolutePath(htmlPath),
      }
    : resolvedDesign;
  const outputPath = path.join(artifactDir, "box-report.json");
  const markdownPath = path.join(artifactDir, "box-report.md");
  const htmlSource = await readFile(design.htmlPath, "utf8");
  if (!hasInlineConfig(htmlSource)) {
    const emptyReport = {
      blocks: [],
      note: "No inline text-layout config found in target HTML.",
      passed: false,
    };
    await writeJsonFile(outputPath, emptyReport);
    await writeTextFile(
      markdownPath,
      [
        "# HTML Box Report",
        "",
        `- design: ${design.designName}`,
        "- comparedBlocks: 0",
        "- passed: false",
        "- note: no inline text-layout config found in target HTML",
        "",
        "> **WARNING**: text-layout config is missing. The text geometry feedback loop is not active.",
        '> Add a `<script type="application/json" data-text-layout-config>` block with tracked blocks to enable it.',
        "",
      ].join("\n"),
    );

    return { markdownPath, outputPath, report: emptyReport };
  }

  const config = extractInlineConfig(htmlSource) as TextLayoutConfig;
  const blocks = readTrackedBlocks({ blockArg, config });

  if (!blocks.length) {
    const emptyReport = {
      blocks: [],
      note: "No tracked text-layout blocks found in inline config.",
      passed: false,
    };
    await writeJsonFile(outputPath, emptyReport);
    await writeTextFile(
      markdownPath,
      [
        "# HTML Box Report",
        "",
        `- design: ${design.designName}`,
        "- comparedBlocks: 0",
        "- passed: false",
        "- note: no tracked text-layout blocks found in inline config",
        "",
        "> **WARNING**: inline config exists but `blocks` array is empty.",
        "> You must add tracked blocks with `id`, `selectors`, and `region` to enable the text geometry feedback loop.",
        "> An empty blocks array means the layout verification is not actually running.",
        "",
      ].join("\n"),
    );

    return { markdownPath, outputPath, report: emptyReport };
  }

  const server = await startStaticServer();
  const browser = await launchEdge();

  try {
    const result = await evaluatePage<{
      blocks: BlockResult[];
      rootBox: { height: number; width: number; x: number; y: number };
    }>({
      expression: `(() => {
        const root = document.querySelector('.design-page') ?? document.querySelector('.sale-page') ?? document.body
        const rootRect = root.getBoundingClientRect()
        const blocks = ${JSON.stringify(
          blocks.map((item) => ({
            id: item.id,
            region: item.region ?? null,
            selectors: item.selectors ?? [],
          })),
        )}

        const toBox = (rect) => ({
          x: Number((rect.left - rootRect.left).toFixed(3)),
          y: Number((rect.top - rootRect.top).toFixed(3)),
          width: Number(rect.width.toFixed(3)),
          height: Number(rect.height.toFixed(3)),
        })

        return {
          rootBox: {
            x: Number(rootRect.left.toFixed(3)),
            y: Number(rootRect.top.toFixed(3)),
            width: Number(rootRect.width.toFixed(3)),
            height: Number(rootRect.height.toFixed(3)),
          },
          blocks: blocks.map((block) => {
            const selectors = Array.isArray(block.selectors)
              ? block.selectors.filter((selector) => typeof selector === 'string' && selector.trim())
              : []
            let element = null
            let selector = selectors[0] ?? ''
            for (const candidate of selectors) {
              try {
                const found = document.querySelector(candidate)
                if (!found) continue
                element = found
                selector = candidate
                break
              } catch {
                // Ignore invalid selector candidates and try the next one.
              }
            }
            if (!element) {
              return {
                deltaHeight: null,
                deltaWidth: null,
                deltaX: null,
                deltaY: null,
                expectedBox: block.region,
                htmlBox: null,
                id: block.id,
                selector,
                selectorCandidates: selectors,
              }
            }

            const htmlBox = toBox(element.getBoundingClientRect())
            const expectedBox = block.region

            return {
              deltaHeight: expectedBox
                ? Number((htmlBox.height - expectedBox.height).toFixed(3))
                : null,
              deltaWidth: expectedBox
                ? Number((htmlBox.width - expectedBox.width).toFixed(3))
                : null,
              deltaX: expectedBox ? Number((htmlBox.x - expectedBox.x).toFixed(3)) : null,
              deltaY: expectedBox ? Number((htmlBox.y - expectedBox.y).toFixed(3)) : null,
              expectedBox,
              htmlBox,
              id: block.id,
              selector,
              selectorCandidates: selectors,
            }
          }),
        }
      })()`,
      port: browser.port,
      readyExpression: 'document.readyState === "complete"',
      url: `${server.origin}${toUrlPath(design.htmlPath)}`,
      viewportHeight: design.height,
      viewportWidth: design.width,
    });

    const missingBoxCount = result.blocks.filter(
      (block) => !block.expectedBox || !block.htmlBox,
    ).length;
    const report = {
      ...result,
      missingBoxCount,
      passed: missingBoxCount === 0,
    };
    await writeJsonFile(outputPath, report);
    await writeTextFile(
      markdownPath,
      [
        "# HTML Box Report",
        "",
        `- design: ${design.designName}`,
        `- comparedBlocks: ${blocks.length}`,
        `- passed: ${report.passed}`,
        `- missingBoxCount: ${missingBoxCount}`,
        "",
        "## Blocks",
        ...report.blocks.map(
          (block) =>
            `- ${block.id}: selector=\`${block.selector}\`, Δx=${formatDelta(block.deltaX)}, Δy=${formatDelta(block.deltaY)}, Δw=${formatDelta(block.deltaWidth)}, Δh=${formatDelta(block.deltaHeight)}`,
        ),
        "",
      ].join("\n"),
    );

    return { markdownPath, outputPath, report };
  } finally {
    await Promise.all([
      Promise.race([
        server.close(),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]),
      Promise.race([
        browser.close(),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]),
    ]);
  }
};

export { createLayoutBoxReport };
