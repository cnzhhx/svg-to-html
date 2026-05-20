import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { inspectSvgSource } from "../pipeline/agent-runner/module-input-summary.js";

const VALUE_FLAGS = new Set([
  "--format",
  "--from-index",
  "--max-elements",
  "--module-dir",
  "--module-svg",
  "--tag",
]);

const INLINE_PREFIXES = [...VALUE_FLAGS].map((flag) => `${flag}=`);

const parseArgs = (args: string[]) => {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;

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

  return {
    format: values.get("--format") ?? "json",
    fromIndex: Number(values.get("--from-index") ?? "0"),
    maxElements: Number(values.get("--max-elements") ?? "120"),
    moduleDir: values.get("--module-dir") ?? ".",
    moduleSvg: values.get("--module-svg") ?? "module.svg",
    tags: (values.get("--tag") ?? "")
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
  };
};

const renderText = (
  payload: ReturnType<typeof inspectSvgSource> & { bytes: number },
) =>
  [
    `bytes: ${payload.bytes}`,
    `viewBox: ${payload.viewBox ?? "n/a"}`,
    `size: ${payload.width ?? "n/a"}x${payload.height ?? "n/a"}`,
    `paths: ${payload.pathCount}`,
    `images: ${payload.imageCount}`,
    `mask/clip/filter: ${payload.maskOrClipCount}`,
    "",
    "tag counts:",
    ...Object.entries(payload.tagCounts)
      .sort((left, right) => right[1] - left[1])
      .map(([tag, count]) => `- ${tag}: ${count}`),
    "",
    "element samples:",
    ...payload.elementSamples.map(
      (element) =>
        `- #${element.index} <${element.tag}> ${JSON.stringify(element.attrs)}`,
    ),
  ].join("\n");

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const moduleDir = path.resolve(args.moduleDir);
  const moduleSvgPath = path.isAbsolute(args.moduleSvg)
    ? args.moduleSvg
    : path.resolve(moduleDir, args.moduleSvg);
  const [svg, svgStat] = await Promise.all([
    readFile(moduleSvgPath, "utf8"),
    stat(moduleSvgPath),
  ]);
  const payload = {
    bytes: svgStat.size,
    ...inspectSvgSource({
      maxElementSamples: Number.isFinite(args.maxElements)
        ? args.maxElements
        : 120,
      fromIndex: Number.isFinite(args.fromIndex) ? args.fromIndex : 0,
      svg,
      tags: args.tags,
    }),
  };

  if (args.format === "text") {
    console.log(renderText(payload));
    return;
  }

  console.log(JSON.stringify(payload, null, 2));
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
