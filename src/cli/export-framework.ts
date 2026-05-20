import { shutdownBrowserPool } from "../core/cdp.js";
import { shutdownStaticServerPool } from "../core/static-server.js";
import {
  resolveArtifactDir,
  resolveDesignPair,
  toAbsolutePath,
} from "../core/utils.js";
import {
  exportFrameworkTargets,
  normalizeOutputFormats,
} from "../pipeline/framework-export/index.js";

const VALUE_FLAGS = new Set(["--formats", "--html", "--regions", "--scale"]);

const parseFlagValue = (args: string[], flag: string) => {
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = args.indexOf(flag);
  if (index >= 0) return args[index + 1];
  return undefined;
};

const parseInputPath = (args: string[]) =>
  args.find((arg, index) => {
    if (arg.startsWith("-")) return false;
    return !VALUE_FLAGS.has(args[index - 1] ?? "");
  });

const parseScale = (args: string[]) => {
  const raw = parseFlagValue(args, "--scale");
  if (raw === undefined) return undefined;
  const scale = Number(raw);
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(`Invalid value for --scale: ${raw}`);
  }
  return scale;
};

const main = async () => {
  const args = process.argv.slice(2);
  const inputPath = parseInputPath(args);
  if (!inputPath) {
    throw new Error(
      "Usage: pnpm exec tsx src/cli/export-framework.ts 设计稿.svg路径 [--formats react,vue] [--html path/to/final.html] [--regions artifacts/modules/module-regions.diff.json] [--scale 1] [--no-verify]",
    );
  }

  const scale = parseScale(args);
  const htmlPath = parseFlagValue(args, "--html");
  const design = await resolveDesignPair(inputPath, { scale });
  const effectiveDesign = htmlPath
    ? {
        ...design,
        htmlPath: toAbsolutePath(htmlPath),
      }
    : design;
  const artifactDir = await resolveArtifactDir(design.svgPath);
  const formats = normalizeOutputFormats(parseFlagValue(args, "--formats") ?? "react,vue");
  const regionsPath = parseFlagValue(args, "--regions");
  const runVerify = !args.includes("--no-verify");

  const result = await exportFrameworkTargets({
    artifactDir,
    design: effectiveDesign,
    formats,
    onProgress: (message) => console.log(message),
    regionsPath,
    runVerify,
  });

  console.log(
    JSON.stringify(
      {
        artifactDir,
        exports: Object.fromEntries(
          Object.entries(result).map(([target, record]) => [
            target,
            {
              cssPath: record?.cssPath,
              dir: record?.dir,
              previewHtmlPath: record?.previewHtmlPath,
              repeatComponentCount: record?.repeatComponentCount,
              status: record?.status,
              verifyReportPath: record?.verifyResult?.verifyReportPath,
            },
          ]),
        ),
        formats,
        htmlPath: effectiveDesign.htmlPath,
      },
      null,
      2,
    ),
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
