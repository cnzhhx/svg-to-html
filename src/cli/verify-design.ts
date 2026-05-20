import { DIFF_RATIO_THRESHOLD } from "../config/runtime.js";
import type { VerifyMode } from "../pipeline/verify/types.js";

const MODE_FLAGS = new Set(["--mode"]);
const MODE_INLINE_PREFIXES = ["--mode="];
const REGION_FLAGS = new Set(["--regions", "--regions-path", "--regionsPath"]);
const REGION_INLINE_PREFIXES = [
  "--regions=",
  "--regions-path=",
  "--regionsPath=",
];
const HTML_FLAGS = new Set(["--html", "--html-path", "--htmlPath"]);
const HTML_INLINE_PREFIXES = ["--html=", "--html-path=", "--htmlPath="];
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
  let regionsPath: string | undefined;
  let htmlPath: string | undefined;
  let runFinalOutputPolicy = true;
  let scale: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;

    if (arg === "--fast") {
      mode = "fast";
      continue;
    }

    if (arg === "--visual-only") {
      runFinalOutputPolicy = false;
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

    const inlinePrefix = REGION_INLINE_PREFIXES.find((prefix) =>
      arg.startsWith(prefix),
    );
    if (inlinePrefix) {
      const value = arg.slice(inlinePrefix.length);
      if (!value)
        throw new Error(`Missing value for ${inlinePrefix.slice(0, -1)}`);
      regionsPath = value;
      continue;
    }

    if (REGION_FLAGS.has(arg)) {
      const value = args[index + 1];
      if (!value || (value !== "-" && value.startsWith("-"))) {
        throw new Error(`Missing value for ${arg}`);
      }
      regionsPath = value;
      index += 1;
      continue;
    }

    const htmlInlinePrefix = HTML_INLINE_PREFIXES.find((prefix) =>
      arg.startsWith(prefix),
    );
    if (htmlInlinePrefix) {
      const value = arg.slice(htmlInlinePrefix.length);
      if (!value)
        throw new Error(`Missing value for ${htmlInlinePrefix.slice(0, -1)}`);
      htmlPath = value;
      continue;
    }

    if (HTML_FLAGS.has(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`Missing value for ${arg}`);
      }
      htmlPath = value;
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
    }
  }

  return { htmlPath, inputPath, mode, regionsPath, runFinalOutputPolicy, scale };
};

const main = async () => {
  const { htmlPath, inputPath, mode, regionsPath, runFinalOutputPolicy, scale } =
    parseArgs(process.argv.slice(2));

  if (!inputPath) {
    throw new Error(
      "Usage: pnpm exec tsx src/cli/verify-design.ts 设计稿.svg路径 [--fast|--mode fast] [--html path/to/draft.html] [--regions path/to/svg-vertical-modules.regions.json] [--scale 1]",
    );
  }

  const {
    DIFF_RATIO_GATE_FAILURE_MESSAGE,
    FINAL_OUTPUT_POLICY_GATE_FAILURE_MESSAGE,
    LAYOUT_BOX_GATE_FAILURE_MESSAGE,
    MODULE_REGION_DIFF_GATE_FAILURE_MESSAGE,
    WORKFLOW_LINT_GATE_FAILURE_MESSAGE,
    verifyDesign,
  } = await import("../pipeline/verify.js");
  const { buildQualityAssessment } =
    await import("../pipeline/agent-runner/verify-gates.js");
  const result = await verifyDesign(
    inputPath,
    (message) => {
      console.log(`[verify] ${message}`);
    },
    undefined,
    regionsPath,
    { htmlPath, mode, runFinalOutputPolicy, scale },
  );
  const qualityAssessment = buildQualityAssessment(result);

  // Compact output: only key metrics for agent consumption (saves thread context tokens)
  const compact = {
    diffRatio: result.diffRatio,
    layoutBoxPassed: result.layoutBoxPassed,
    workflowLintPassed: result.workflowLintPassed,
    finalOutputPolicyPassed: result.finalOutputPolicyPassed,
    fontRenderingLimitLikely: result.fontRenderingLimitLikely,
    fontRenderingLimitReason: result.fontRenderingLimitReason,
    qualityStatus: qualityAssessment.status,
    qualityBlockingIssues: qualityAssessment.blockingIssues,
    qualitySoftIssues: qualityAssessment.softIssues,
    textContentPriorityIssueCount: result.textContentPriorityIssueCount ?? 0,
    textGeometryPriorityIssueCount: result.textGeometryPriorityIssueCount ?? 0,
    textPriorityIssueCount: result.textPriorityIssueCount ?? 0,
    mode: result.mode ?? mode,
    ocrProvider: result.ocrProvider,
    artifactDir: result.artifactDir,
    htmlPath,
    ...(result.regionsPath
      ? {
          regionsPath: result.regionsPath,
          moduleRegionDiffFailures: result.moduleRegionDiffFailures,
          moduleRegionDiffPassed: result.moduleRegionDiffPassed,
          moduleRegionDiffThreshold: result.moduleRegionDiffThreshold,
          moduleRegionSummary: result.moduleRegionSummary,
        }
      : {}),
  };
  console.log(JSON.stringify(compact));

  if (mode === "fast") {
    if (
      result.diffRatio > DIFF_RATIO_THRESHOLD &&
      !result.fontRenderingLimitLikely
    ) {
      throw new Error(DIFF_RATIO_GATE_FAILURE_MESSAGE);
    }
    if (result.finalOutputPolicyPassed === false) {
      throw new Error(FINAL_OUTPUT_POLICY_GATE_FAILURE_MESSAGE);
    }
    if (result.moduleRegionDiffPassed === false) {
      throw new Error(MODULE_REGION_DIFF_GATE_FAILURE_MESSAGE);
    }
    return;
  }

  if (
    result.diffRatio > DIFF_RATIO_THRESHOLD &&
    !result.fontRenderingLimitLikely
  ) {
    throw new Error(DIFF_RATIO_GATE_FAILURE_MESSAGE);
  }
  if (!result.layoutBoxPassed) {
    throw new Error(LAYOUT_BOX_GATE_FAILURE_MESSAGE);
  }
  if (result.finalOutputPolicyPassed === false) {
    throw new Error(FINAL_OUTPUT_POLICY_GATE_FAILURE_MESSAGE);
  }
  if (result.moduleRegionDiffPassed === false) {
    throw new Error(MODULE_REGION_DIFF_GATE_FAILURE_MESSAGE);
  }
  if ((result.textPriorityIssueCount ?? 0) > 0) {
    throw new Error(
      `Text priority gate failed: ${result.textPriorityIssueCount} issue(s)`,
    );
  }
  if (!result.workflowLintPassed) {
    throw new Error(WORKFLOW_LINT_GATE_FAILURE_MESSAGE);
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
