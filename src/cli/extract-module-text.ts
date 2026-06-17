import path from "node:path";
import { readFile } from "node:fs/promises";

import { shutdownBrowserPool } from "../core/cdp.js";
import { createModuleTextBlocks } from "../core/module-text-blocks.js";
import { toAbsolutePath, writeJsonFile } from "../core/utils.js";
import {
  buildModuleSemanticTextHints,
  type ModuleSemanticDocument,
} from "../pipeline/agent-runner/module-semantic.js";

const parseArgs = (args: string[]) => {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    const inline = arg.match(/^(--[^=]+)=(.*)$/);
    if (inline) {
      values.set(inline[1]!, inline[2]!);
      continue;
    }
    if (arg.startsWith("--")) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      values.set(arg, value);
      index += 1;
    }
  }
  return {
    moduleDir: values.get("--module-dir") ?? ".",
    moduleId: values.get("--module-id"),
    moduleSemanticPath:
      values.get("--semantic") ?? values.get("--module-semantic"),
    moduleSvgPath: values.get("--module-svg") ?? "module.svg",
    scale: values.get("--scale") ? Number(values.get("--scale")) : undefined,
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
