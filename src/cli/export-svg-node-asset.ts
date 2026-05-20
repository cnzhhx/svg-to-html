import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { capturePage, evaluatePage, launchEdge } from "../core/cdp.js";

type Clip = {
  height: number;
  width: number;
  x: number;
  y: number;
};

type ExportResult =
  | {
      clip: Clip;
      index: number;
      ok: true;
      renderedBox: Clip;
      rootSize: {
        height: number;
        width: number;
      };
      tag: string;
    }
  | {
      error: string;
      ok: false;
    };

const VALUE_FLAGS = new Set([
  "--index",
  "--module-dir",
  "--module-svg",
  "--output",
  "--padding",
  "--scale",
  "--selector",
]);

const INLINE_PREFIXES = [...VALUE_FLAGS].map((flag) => `${flag}=`);

const parseArgs = (args: string[]) => {
  const values = new Map<string, string>();
  let help = false;

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
      values.set(inlinePrefix.slice(0, -1), arg.slice(inlinePrefix.length));
      continue;
    }

    if (VALUE_FLAGS.has(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith("-"))
        throw new Error(`Missing value for ${arg}`);
      values.set(arg, value);
      index += 1;
    }
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
  const padding = rawPadding === undefined ? 2 : Number(rawPadding);
  if (!Number.isFinite(padding) || padding < 0) {
    throw new Error("--padding must be a non-negative number");
  }

  const rawScale = values.get("--scale");
  const scale = rawScale === undefined ? 1 : Number(rawScale);
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(`Invalid value for --scale: ${rawScale} (expected a positive number)`);
  }

  const selector = values.get("--selector");
  if (!help && elementIndex === undefined && !selector) {
    throw new Error("Provide either --index <inspect-index> or --selector <css-selector>");
  }

  const output = values.get("--output");
  if (!help && !output) {
    throw new Error("Missing required --output <assets/name.png>");
  }

  return {
    elementIndex,
    help,
    moduleDir: values.get("--module-dir") ?? ".",
    moduleSvg: values.get("--module-svg") ?? "module.svg",
    output,
    padding,
    scale,
    selector,
  };
};

const usage = () =>
  [
    "Usage:",
    "  pnpm exec tsx src/cli/export-svg-node-asset.ts --module-dir <module-dir> --index <inspect-index> --output assets/name.png [--padding 2] [--scale 1]",
    "  pnpm exec tsx src/cli/export-svg-node-asset.ts --module-dir <module-dir> --selector '<css-selector>' --output assets/name.png [--padding 2] [--scale 1]",
    "",
    "Notes:",
    "  - Exports one visible node from module.svg with a transparent page background.",
    "  - --index uses the # index shown by inspect-module-svg.ts.",
    "  - --scale must match the session SVG render scale passed by upload/CLI.",
    "  - The selected node is rendered in its original SVG coordinate context while non-selected sibling visuals are hidden.",
  ].join("\n");

const parseAttrs = (source: string) => {
  const attrs: Record<string, string> = {};
  const attrPattern =
    /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const match of source.matchAll(attrPattern)) {
    const name = match[1];
    if (!name) continue;
    attrs[name] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
};

const parseNumberAttr = (value: string | undefined) => {
  const match = value?.match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const readSvgDimensions = (svg: string) => {
  const rootAttrs = parseAttrs(svg.match(/<svg\b([^>]*)>/i)?.[1] ?? "");
  const viewBoxParts = rootAttrs.viewBox?.trim().split(/[\s,]+/) ?? [];
  const width =
    parseNumberAttr(rootAttrs.width) ?? parseNumberAttr(viewBoxParts[2]);
  const height =
    parseNumberAttr(rootAttrs.height) ?? parseNumberAttr(viewBoxParts[3]);

  return {
    height: Math.max(1, Math.ceil(height ?? 1000)),
    width: Math.max(1, Math.ceil(width ?? 1000)),
  };
};

const scaleClip = (clip: Clip, scale: number) => ({
  height: Number((clip.height * scale).toFixed(6)),
  width: Number((clip.width * scale).toFixed(6)),
  x: Number((clip.x * scale).toFixed(6)),
  y: Number((clip.y * scale).toFixed(6)),
});

const stripXmlPreamble = (svg: string) =>
  svg
    .replace(/^\s*<\?xml[\s\S]*?\?>/i, "")
    .replace(/^\s*<!doctype[\s\S]*?>/i, "");

const jsonForScript = (value: unknown) =>
  JSON.stringify(value).replace(/</g, "\\u003c");

const buildWrapperHtml = ({
  elementIndex,
  padding,
  selector,
  svg,
}: {
  elementIndex?: number;
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
        overflow: hidden;
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
      const exportSpec = ${jsonForScript({ elementIndex, padding, selector })};

      const setResult = (result) => {
        window.__EXPORT_RESULT__ = result;
        window.__RENDER_READY__ = true;
      };

      const isDefsNode = (node) => {
        if (!(node instanceof Element)) return false;
        return Boolean(node.closest("defs"));
      };

      const keepNodeVisible = (node, target) =>
        node === target ||
        target.contains(node) ||
        node.contains(target) ||
        isDefsNode(node);

      window.addEventListener("load", () => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            try {
              const svg = document.querySelector("svg");
              if (!svg) {
                setResult({ ok: false, error: "No <svg> root found" });
                return;
              }

              const allNodes = [svg, ...svg.querySelectorAll("*")];
              const target = exportSpec.selector
                ? svg.querySelector(exportSpec.selector)
                : allNodes[exportSpec.elementIndex];

              if (!target) {
                setResult({
                  ok: false,
                  error: exportSpec.selector
                    ? "No node matched --selector"
                    : "No node matched --index",
                });
                return;
              }

              if (isDefsNode(target)) {
                setResult({
                  ok: false,
                  error: "Selected node is inside <defs> and is not directly renderable",
                });
                return;
              }

              const rect = target.getBoundingClientRect();
              if (!rect.width || !rect.height) {
                setResult({
                  ok: false,
                  error: "Selected node has an empty rendered bounding box",
                });
                return;
              }

              for (const node of allNodes) {
                if (!(node instanceof SVGElement)) continue;
                if (keepNodeVisible(node, target)) {
                  node.style.setProperty("visibility", "visible", "important");
                } else {
                  node.style.setProperty("visibility", "hidden", "important");
                }
              }

              const padding = exportSpec.padding;
              const clipX = Math.max(0, Math.floor(rect.left - padding));
              const clipY = Math.max(0, Math.floor(rect.top - padding));
              const clipRight = Math.ceil(rect.right + padding);
              const clipBottom = Math.ceil(rect.bottom + padding);

              setResult({
                ok: true,
                index: allNodes.indexOf(target),
                tag: target.tagName.toLowerCase(),
                renderedBox: {
                  x: rect.left,
                  y: rect.top,
                  width: rect.width,
                  height: rect.height,
                },
                clip: {
                  x: clipX,
                  y: clipY,
                  width: Math.max(1, clipRight - clipX),
                  height: Math.max(1, clipBottom - clipY),
                },
                rootSize: {
                  width: svg.getBoundingClientRect().width,
                  height: svg.getBoundingClientRect().height,
                },
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

  const svg = await readFile(moduleSvgPath, "utf8");
  const dimensions = readSvgDimensions(svg);
  const wrapperDir = await mkdtemp(path.join(os.tmpdir(), "svg-node-asset-"));
  const wrapperPath = path.join(wrapperDir, "export.html");

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(
    wrapperPath,
    buildWrapperHtml({
      elementIndex: args.elementIndex,
      padding: args.padding,
      selector: args.selector,
      svg,
    }),
    "utf8",
  );

  const browser = await launchEdge();

  try {
    const url = pathToFileURL(wrapperPath).href;
    const result = await evaluatePage<ExportResult>({
      expression: "window.__EXPORT_RESULT__",
      port: browser.port,
      url,
      viewportHeight: dimensions.height,
      viewportWidth: dimensions.width,
    });

    if (!result?.ok) {
      throw new Error(result?.error ?? "Failed to prepare SVG node export");
    }

    await capturePage({
      clip: result.clip,
      deviceScaleFactor: args.scale,
      outputPath,
      port: browser.port,
      transparentBackground: true,
      url,
      viewportHeight: dimensions.height,
      viewportWidth: dimensions.width,
    });

    console.log(
      JSON.stringify(
        {
          clip: result.clip,
          moduleSvgPath,
          outputPath,
          padding: args.padding,
          renderedClip: scaleClip(result.clip, args.scale),
          scale: args.scale,
          selected: {
            index: result.index,
            renderedBox: result.renderedBox,
            renderedPixelBox: scaleClip(result.renderedBox, args.scale),
            tag: result.tag,
          },
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
