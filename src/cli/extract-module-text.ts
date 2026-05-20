import path from "node:path";

import { shutdownBrowserPool } from "../core/cdp.js";
import { createModuleTextBlocks } from "../core/module-text-blocks.js";
import { toAbsolutePath } from "../core/utils.js";

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
    moduleDir: values.get("--module-dir") ?? values.get("--moduleDir") ?? ".",
    moduleId: values.get("--module-id") ?? values.get("--moduleId"),
    moduleOcrBlocksPath:
      values.get("--ocr") ??
      values.get("--module-ocr-blocks") ??
      values.get("--moduleOcrBlocks"),
    moduleSvgPath:
      values.get("--module-svg") ?? values.get("--moduleSvg") ?? "module.svg",
    outputPath: values.get("--out"),
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
  const moduleOcrBlocksPath = args.moduleOcrBlocksPath
    ? toAbsolutePath(args.moduleOcrBlocksPath)
    : path.join(moduleDir, "module-ocr-blocks.json");
  const outputPath = args.outputPath ? toAbsolutePath(args.outputPath) : undefined;
  if (args.scale !== undefined && (!Number.isFinite(args.scale) || args.scale <= 0)) {
    throw new Error(`Invalid value for --scale: ${args.scale} (expected a positive number)`);
  }
  const result = await createModuleTextBlocks({
    moduleDir,
    moduleId,
    moduleOcrBlocksPath,
    moduleSvgPath,
    outputPath,
    region: { height: 0, width: 0, x: 0, y: 0 },
    scale: args.scale,
  });
  console.log(
    JSON.stringify({
      blockCount: result.blockCount,
      generatedBy: result.generatedBy,
      outputPath: outputPath ?? path.join(moduleDir, "module-text-blocks.json"),
      previewPath: result.previewPath,
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
