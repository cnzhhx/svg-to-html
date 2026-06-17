import type { VerifyMode } from "../pipeline/verify/types.js";

const MODE_FLAGS = new Set(["--mode"]);
const MODE_INLINE_PREFIXES = ["--mode="];
const RENDER_ENTRY_FLAGS = new Set(["--render-entry", "--render-entry-path"]);
const RENDER_ENTRY_INLINE_PREFIXES = [
  "--render-entry=",
  "--render-entry-path=",
];
const SCALE_FLAGS = new Set(["--scale"]);
const SCALE_INLINE_PREFIXES = ["--scale="];

const parseMode = (value: string, flag: string): VerifyMode => {
  if (value === "fast" || value === "full") return value;
  throw new Error(
    `Invalid value for ${flag}: ${value} (expected fast or full)`,
  );
};

const parseArgs = (args: string[]) => {
  let inputPath: string | undefined;
  let mode: VerifyMode = "full";
  let renderEntryPath: string | undefined;
  let scale: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;

    if (arg === "--fast") {
      mode = "fast";
      continue;
    }

    const modeInlinePrefix = MODE_INLINE_PREFIXES.find((prefix) =>
      arg.startsWith(prefix),
    );
    if (modeInlinePrefix) {
      const value = arg.slice(modeInlinePrefix.length);
      if (!value)
        throw new Error(`Missing value for ${modeInlinePrefix.slice(0, -1)}`);
      mode = parseMode(value, modeInlinePrefix.slice(0, -1));
      continue;
    }

    if (MODE_FLAGS.has(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`Missing value for ${arg}`);
      }
      mode = parseMode(value, arg);
      index += 1;
      continue;
    }

    const renderEntryInlinePrefix = RENDER_ENTRY_INLINE_PREFIXES.find((prefix) =>
      arg.startsWith(prefix),
    );
    if (renderEntryInlinePrefix) {
      const value = arg.slice(renderEntryInlinePrefix.length);
      if (!value)
        throw new Error(`Missing value for ${renderEntryInlinePrefix.slice(0, -1)}`);
      renderEntryPath = value;
      continue;
    }

    if (RENDER_ENTRY_FLAGS.has(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`Missing value for ${arg}`);
      }
      renderEntryPath = value;
      index += 1;
      continue;
    }

    const scaleInlinePrefix = SCALE_INLINE_PREFIXES.find((prefix) =>
      arg.startsWith(prefix),
    );
    if (scaleInlinePrefix) {
      const value = arg.slice(scaleInlinePrefix.length);
      if (!value)
        throw new Error(`Missing value for ${scaleInlinePrefix.slice(0, -1)}`);
      scale = Number(value);
      if (!Number.isFinite(scale) || scale <= 0) {
        throw new Error(
          `Invalid value for ${scaleInlinePrefix.slice(0, -1)}: ${value} (expected a positive number)`,
        );
      }
      continue;
    }

    if (SCALE_FLAGS.has(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`Missing value for ${arg}`);
      }
      scale = Number(value);
      if (!Number.isFinite(scale) || scale <= 0) {
        throw new Error(
          `Invalid value for ${arg}: ${value} (expected a positive number)`,
        );
      }
      index += 1;
      continue;
    }

    if (!arg.startsWith("-") && !inputPath) {
      inputPath = arg;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return { inputPath, mode, renderEntryPath, scale };
};

const main = async () => {
  const { inputPath, mode, renderEntryPath, scale } =
    parseArgs(process.argv.slice(2));

  if (!inputPath) {
    throw new Error(
      "Usage: pnpm exec tsx src/cli/verify-design.ts 设计稿.svg路径 --render-entry path/to/render-entry.html [--fast|--mode fast] [--scale 1]",
    );
  }
  if (!renderEntryPath) {
    throw new Error("Missing required option: --render-entry");
  }
  const requiredInputPath = inputPath;
  const requiredRenderEntryPath = renderEntryPath;

  const { verifyDesign } = await import("../pipeline/verify.js");
  const result = await verifyDesign(
    requiredInputPath,
    () => {},
    undefined,
    { mode, renderEntryPath: requiredRenderEntryPath, scale },
  );

  // Compact output: only key metrics for agent consumption (saves thread context tokens)
  const compact = {
    diffRatio: result.diffRatio,
    mode: result.mode ?? mode,
    artifactDir: result.artifactDir,
    renderEntryPath: requiredRenderEntryPath,
    renderPngPath: result.renderPngPath,
  };
  console.log(JSON.stringify(compact));
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
