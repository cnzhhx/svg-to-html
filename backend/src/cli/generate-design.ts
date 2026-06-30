import { createContainerLayoutReport } from "../core/container-layout/index.js";
import { shutdownBrowserPool } from "../core/cdp.js";
import { initializeDesignScaffolds } from "../core/design-scaffold.js";
import { parseOutputFormat } from "../core/output-target.js";
import { buildSemiAutoScaffoldArtifacts } from "../core/semi-auto-scaffold/index.js";
import { shutdownStaticServerPool } from "../core/static-server.js";
import { parseFlagValue } from "./cli-utils.js";

const VALUE_FLAGS = new Set(["--format", "--scale"]);

const parseInputPath = (args: string[]) =>
  args.find((arg, index) => {
    if (arg === "force" || arg.startsWith("-")) return false;
    return !VALUE_FLAGS.has(args[index - 1] ?? "");
  });

const parseScale = (args: string[]) => {
  const raw = parseFlagValue(args, "--scale");
  if (raw === undefined) return undefined;
  const scale = Number(raw);
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(`Invalid value for --scale: ${raw} (expected a positive number)`);
  }
  return scale;
};

const parseFormat = (args: string[]) => {
  const raw = parseFlagValue(args, "--format");
  if (!raw) {
    throw new Error(
      "Missing required --format <html|vue|react>",
    );
  }
  return parseOutputFormat(raw);
};

const main = async () => {
  const args = process.argv.slice(2);
  const inputPath = parseInputPath(args);
  const overwrite = args.includes("--force") || args.includes("force");
  const format = parseFormat(args);
  const scale = parseScale(args);

  if (!inputPath) {
    throw new Error(
      "Usage: pnpm exec tsx src/cli/generate-design.ts 设计稿.svg路径 --format <html|vue|react> [--force|force] [--scale 1]",
    );
  }
  const containerLayout = await createContainerLayoutReport({
    inputPath,
    scale,
  });
  const semiAuto = await buildSemiAutoScaffoldArtifacts({
    containerLayoutReport: containerLayout.report,
    inputPath,
    scale,
    svgLayoutReport: containerLayout.svgLayout,
  });
  const design = await initializeDesignScaffolds({
    format,
    inputPath,
    overwrite,
    renderContent: semiAuto.htmlScaffold,
    scale,
  });

  console.log(`[generate] Source entry ready: ${design.outputTarget.sourceEntryPath}`);
  if (design.outputTarget.sourceStylePath) {
    console.log(`[generate] Source style ready: ${design.outputTarget.sourceStylePath}`);
  }
  console.log(`[generate] Render entry ready: ${design.outputTarget.renderEntryPath}`);
  console.log(`[generate] Compare entry ready: ${design.outputTarget.compareEntryPath}`);
  console.log(
    `[generate] Container layout preflight created: ${containerLayout.markdownPath}`,
  );
  console.log(
    `[generate] Structure draft created: ${semiAuto.structureDraftPath}`,
  );

  console.log(
    `[generate] Scaffold decisions created: ${semiAuto.scaffoldDecisionsPath}`,
  );

  console.log(
    [
      "Design scaffolds initialized. This is a semi-auto starting point, not a completed restoration:",
      `- Format: ${format}`,
      `- Source Entry: ${design.outputTarget.sourceEntryPath}`,
      `- Render Entry: ${design.outputTarget.renderEntryPath}`,
      `- Compare Entry: ${design.outputTarget.compareEntryPath}`,
      `- Container Layout: ${containerLayout.markdownPath}`,
      `- Structure Draft: ${semiAuto.structureDraftPath}`,
      `- Scaffold Decisions: ${semiAuto.scaffoldDecisionsPath}`,
      "- Next: read Container Layout + Rebuild Recipes first, then rebuild source, refresh render entry, then run verify-design",
    ].join("\n"),
  );
};

void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([
      shutdownBrowserPool(),
      shutdownStaticServerPool(),
    ]);
  });
