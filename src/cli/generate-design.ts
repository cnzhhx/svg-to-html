import { createContainerLayoutReport } from "../core/container-layout.js";
import { shutdownBrowserPool } from "../core/cdp.js";
import { initializeDesignScaffold } from "../core/design-scaffold.js";
import { buildSemiAutoScaffoldArtifacts } from "../core/semi-auto-scaffold.js";
import { shutdownStaticServerPool } from "../core/static-server.js";

const VALUE_FLAGS = new Set(["--scale"]);

const parseFlagValue = (args: string[], flag: string) => {
  const inlineArg = args.find((arg) => arg.startsWith(`${flag}=`));
  if (inlineArg) return inlineArg.slice(flag.length + 1);

  const flagIndex = args.indexOf(flag);
  if (flagIndex >= 0) return args[flagIndex + 1];

  return undefined;
};

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

const main = async () => {
  const args = process.argv.slice(2);
  const inputPath = parseInputPath(args);
  const overwrite = args.includes("--force") || args.includes("force");
  const scale = parseScale(args);

  if (!inputPath) {
    throw new Error(
      "Usage: pnpm exec tsx src/cli/generate-design.ts 设计稿.svg路径 [--force|force] [--scale 1]",
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
  const design = await initializeDesignScaffold({
    htmlContent: semiAuto.htmlScaffold,
    inputPath,
    overwrite,
    scale,
  });

  console.log(`[generate] HTML scaffold ready: ${design.htmlPath}`);
  console.log(`[generate] Compare HTML ready: ${design.compareHtmlPath}`);
  console.log(
    `[generate] Container layout preflight created: ${containerLayout.markdownPath}`,
  );
  console.log(`[generate] OCR blocks created: ${semiAuto.ocrBlocksPath}`);
  console.log(
    `[generate] Structure draft created: ${semiAuto.structureDraftPath}`,
  );
  console.log(
    `[generate] Shell manifest created: ${semiAuto.shellManifestPath}`,
  );
  console.log(
    `[generate] Scaffold decisions created: ${semiAuto.scaffoldDecisionsPath}`,
  );

  console.log(
    [
      "Design scaffolds initialized. This is a semi-auto starting point, not a completed restoration:",
      `- HTML: ${design.htmlPath}`,
      `- Compare HTML: ${design.compareHtmlPath}`,
      `- Container Layout: ${containerLayout.markdownPath}`,
      `- OCR Blocks: ${semiAuto.ocrBlocksPath}`,
      `- Structure Draft: ${semiAuto.structureDraftPath}`,
      `- Shell Manifest: ${semiAuto.shellManifestPath}`,
      `- Scaffold Decisions: ${semiAuto.scaffoldDecisionsPath}`,
      "- Next: read Container Layout + Rebuild Recipes first, then rebuild HTML, then run verify-design",
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
