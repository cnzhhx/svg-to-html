import { getPngRasterScaleMultiplier } from "../config/index.js";

type ExportSvgNodeAssetArgs = {
  allowText: boolean;
  assetRole?: string;
  elementIndex?: number;
  help: boolean;
  moduleDir: string;
  moduleSvg: string;
  nodeIds: string[];
  noRegisterSemantic: boolean;
  output?: string;
  padding: number;
  registerSemantic: boolean;
  scale: number;
  selector?: string;
  textTreatment?: string;
};

const VALUE_FLAGS = new Set([
  "--asset-role",
  "--index",
  "--module-dir",
  "--module-svg",
  "--output",
  "--padding",
  "--scale",
  "--selector",
  "--text-treatment",
]);
const MULTI_VALUE_FLAGS = new Set(["--node-id"]);
const BOOLEAN_FLAGS = new Set([
  "--allow-text",
  "--no-register-semantic",
  "--register-semantic",
]);
const INLINE_PREFIXES = [
  ...VALUE_FLAGS,
  ...MULTI_VALUE_FLAGS,
  ...BOOLEAN_FLAGS,
].map((flag) => `${flag}=`);

const parseExportSvgNodeAssetArgs = (args: string[]): ExportSvgNodeAssetArgs => {
  const values = new Map<string, string>();
  const multiValues = new Map<string, string[]>();
  const booleans = new Set<string>();
  let help = false;

  const pushMultiValue = (flag: string, value: string) => {
    const next = multiValues.get(flag) ?? [];
    next.push(value);
    multiValues.set(flag, next);
  };

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
      const flag = inlinePrefix.slice(0, -1);
      const value = arg.slice(inlinePrefix.length);
      if (BOOLEAN_FLAGS.has(flag)) {
        if (value !== "" && value !== "true") {
          throw new Error(`${flag} does not take a value`);
        }
        booleans.add(flag);
      } else if (MULTI_VALUE_FLAGS.has(flag)) {
        pushMultiValue(flag, value);
      } else {
        values.set(flag, value);
      }
      continue;
    }

    if (BOOLEAN_FLAGS.has(arg)) {
      booleans.add(arg);
      continue;
    }

    if (VALUE_FLAGS.has(arg) || MULTI_VALUE_FLAGS.has(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`Missing value for ${arg}`);
      }
      if (MULTI_VALUE_FLAGS.has(arg)) {
        pushMultiValue(arg, value);
      } else {
        values.set(arg, value);
      }
      index += 1;
    }
  }

  const rawNodeIds = multiValues.get("--node-id") ?? [];
  const nodeIds = rawNodeIds
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  const rawIndex = values.get("--index");
  const elementIndex = rawIndex === undefined ? undefined : Number(rawIndex);
  if (
    elementIndex !== undefined &&
    (!Number.isInteger(elementIndex) || elementIndex < 0)
  ) {
    throw new Error("--index must be a non-negative integer");
  }

  const rawPadding = values.get("--padding");
  const padding = rawPadding === undefined ? 0 : Number(rawPadding);
  if (!Number.isFinite(padding) || padding < 0) {
    throw new Error("--padding must be a non-negative number");
  }

  const rawScale = values.get("--scale");
  const scale = rawScale === undefined ? 1 : Number(rawScale);
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(
      `Invalid value for --scale: ${rawScale} (expected a positive number)`,
    );
  }

  const selector = values.get("--selector");
  const selectionModeCount =
    Number(elementIndex !== undefined) +
    Number(Boolean(selector)) +
    Number(nodeIds.length > 0);
  if (!help && selectionModeCount !== 1) {
    throw new Error(
      "Provide exactly one of --index <inspect-index>, --selector <css-selector>, or --node-id <semantic-node-id>",
    );
  }
  if (
    booleans.has("--register-semantic") &&
    booleans.has("--no-register-semantic")
  ) {
    throw new Error(
      "Provide at most one of --register-semantic or --no-register-semantic",
    );
  }

  const output = values.get("--output");
  if (!help && !output) {
    throw new Error("Missing required --output <assets/name.png>");
  }

  return {
    allowText: booleans.has("--allow-text"),
    assetRole: values.get("--asset-role") ?? undefined,
    elementIndex,
    help,
    moduleDir: values.get("--module-dir") ?? ".",
    moduleSvg: values.get("--module-svg") ?? "module.svg",
    nodeIds,
    noRegisterSemantic: booleans.has("--no-register-semantic"),
    output,
    padding,
    registerSemantic: booleans.has("--register-semantic"),
    scale,
    selector,
    textTreatment: values.get("--text-treatment") ?? undefined,
  };
};

const getExportSvgNodeAssetUsage = () =>
  [
    "Usage:",
    "  pnpm exec tsx src/cli/export-svg-node-asset.ts --module-dir <module-dir> --index <inspect-index> --output assets/name.png [--padding 0] [--scale 1]",
    "  pnpm exec tsx src/cli/export-svg-node-asset.ts --module-dir <module-dir> --selector '<css-selector>' --output assets/name.png [--padding 0] [--scale 1]",
    "  pnpm exec tsx src/cli/export-svg-node-asset.ts --module-dir <module-dir> --node-id n0001 --node-id n0002 --output assets/name.png [--register-semantic] [--padding 0] [--scale 1]",
    "",
    "Notes:",
    "  - Exports one or more visible SVG nodes from module.svg with a transparent page background.",
    "  - --node-id reads node ids from module-semantic.json; pass multiple --node-id flags to merge any number of nodes into one export.",
    "  - Selected semantic nodes must not be preprocessed DOM textBlocks or contain those textBlock descendants.",
    "  - Exported visuals may contain non-textBlocks text such as decorative labels, badges, screenshots, or raster content.",
    "  - Visual text assets (`textHandling=export-asset`, `exportDecision=export`) are exportable.",
    "  - --allow-text bypasses the preprocessed textBlock validation and is intended for internal probe rendering only.",
    "  - Overlap with text outside the selected nodes is allowed.",
    "  - --node-id exports automatically write/update generatedAssets with readableByAgent=true; --register-semantic makes that requirement explicit.",
    "  - --scale must match the session SVG render scale passed by upload/CLI.",
    `  - PNG output adds a ${getPngRasterScaleMultiplier()}x raster multiplier on top of layout scale for sharper crops.`,
    "  - The selected nodes are rendered in their original SVG coordinate context while non-selected sibling visuals are hidden.",
  ].join("\n");

export { getExportSvgNodeAssetUsage, parseExportSvgNodeAssetArgs };
export type { ExportSvgNodeAssetArgs };
