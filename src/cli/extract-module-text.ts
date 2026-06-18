import path from "node:path";
import { readFile } from "node:fs/promises";

import { shutdownBrowserPool } from "../core/cdp.js";
import { createModuleTextBlocks } from "../core/module-text-blocks.js";
import { toAbsolutePath } from "../core/paths.js";
import { writeJsonFile } from "../core/file-io.js";
import {
  buildModuleSemanticTextHints,
  type ModuleSemanticDocument,
} from "../pipeline/agent-runner/module/module-semantic.js";
import { parseCliFlags } from "./cli-utils.js";

const VALUE_FLAGS = new Set([
  "--module-dir",
  "--module-id",
  "--module-svg",
  "--scale",
  "--semantic",
  "--module-semantic",
]);

const parseArgs = (args: string[]) => {
  const { flags } = parseCliFlags(args, VALUE_FLAGS);
  return {
    moduleDir: flags.get("--module-dir") ?? ".",
    moduleId: flags.get("--module-id"),
    moduleSemanticPath:
      flags.get("--semantic") ?? flags.get("--module-semantic"),
    moduleSvgPath: flags.get("--module-svg") ?? "module.svg",
    scale: flags.get("--scale") ? Number(flags.get("--scale")) : undefined,
  };
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const moduleDir = toAbsolutePath(args.moduleDir);
  const moduleId = args.moduleId ?? path.basename(moduleDir);
  const moduleSvgPath = path.isAbsolute(args.moduleSvgPath)
    ? args.moduleSvgPath
    : path.resolve(moduleDir, args.moduleSvgPath);
  const moduleSemanticPath = args.moduleSemanticPath
    ? toAbsolutePath(args.moduleSemanticPath)
    : path.join(moduleDir, "module-semantic.json");
  if (args.scale !== undefined && (!Number.isFinite(args.scale) || args.scale <= 0)) {
    throw new Error(`Invalid value for --scale: ${args.scale} (expected a positive number)`);
  }
  const semanticDocument = JSON.parse(
    await readFile(moduleSemanticPath, "utf8"),
  ) as ModuleSemanticDocument;
  const result = await createModuleTextBlocks({
    moduleDir,
    moduleId,
    textHints: buildModuleSemanticTextHints(semanticDocument),
    moduleSvgPath,
    region: semanticDocument.module.region,
    scale: args.scale,
  });

  // Converge textBlocks back into module-semantic.json
  const updatedSemantic: ModuleSemanticDocument = {
    ...semanticDocument,
    textBlocks: result.blocks.map((block) => ({
      id: block.id,
      kind: block.kind,
      lineCount: block.lineCount,
      lineRegions: block.lineRegions,
      lines: block.lines,
      sourceNodeIds: block.sourceBlockId ? [block.sourceBlockId] : [],
      text: block.text,
      textRegion: block.textRegion ?? block.region,
      ...(block.color ? { color: block.color } : {}),
      ...(block.renderedTextRegion
        ? { renderedTextRegion: block.renderedTextRegion }
        : {}),
    })),
    runtime: {
      ...semanticDocument.runtime,
      completedStages: [
        ...new Set([
          ...semanticDocument.runtime.completedStages,
          "text-blocks",
        ]),
      ].sort((left, right) => left.localeCompare(right)),
    },
  };
  await writeJsonFile(moduleSemanticPath, updatedSemantic);

  console.log(
    JSON.stringify({
      blockCount: result.blockCount,
      generatedBy: result.generatedBy,
      outputPath: null,
      previewPath: result.previewPath,
      semanticPath: moduleSemanticPath,
    }),
  );
};

void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await shutdownBrowserPool();
  });
