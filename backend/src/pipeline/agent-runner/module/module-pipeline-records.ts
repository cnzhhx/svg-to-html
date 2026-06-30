import type { SvgVerticalModule } from "../../../core/svg-vertical-modules/types.js";
import type { AgentTurnMetrics } from "../turn/agent-turn-types.js";

type ModuleAgentRunRecord = {
  cachedInputTokens?: number;
  durationMs: number;
  endedAt: number;
  error?: string;
  finalDiffRatio?: number;
  id: string;
  inputTokens: number;
  outputByteSizes?: {
    manifest: number;
    moduleCss: number;
    previewFragmentHtml: number;
    sourceData?: number;
    sourceFragment?: number;
  };
  agentGeneratedAssetCount?: number;
  outputPaths?: {
    manifest: string;
    moduleCss: string;
    moduleSemanticJson?: string;
    moduleSvg: string;
    previewFragmentHtml: string;
    sourceData?: string;
    sourceFragment?: string;
  };
  outputTokens: number;
  promptKind: "initial" | "revision";
  region: SvgVerticalModule["region"];
  round: number;
  startedAt: number;
  status: "completed" | "failed";
  threadId: string;
  turnSummary?: {
    durationMs: number;
    earlyStopReason?: string;
    internalDiffTimeline: Array<{ diffRatio: number; round: number }>;
    metrics?: AgentTurnMetrics;
    totalCommands: number;
    totalInternalRounds: number;
    totalShellCommands?: number;
    verifyCount: number;
  };
  uncachedInputTokens?: number;
};

type ModuleValidationFailureKind =
  | "incomplete_output"
  | "merge_failed"
  | "module_framework_failed"
  | "module_input_failed"
  | "module_visual_failed";

type ModuleValidationStat = {
  diffPixels?: number;
  diffRatio: number;
  failureKind?: ModuleValidationFailureKind;
  id: string;
  maxChannelDelta?: number;
  mergeError?: string;
  passed: boolean;
  renderPngPath?: string;
};

type ModuleValidationRun = {
  draftHtmlPath?: string;
  diffRatio: number;
  failedModuleIds?: string[];
  moduleStats: ModuleValidationStat[];
  round: number;
  scope: "agent-local" | "merged-page";
  threshold: number;
};

const MODULE_VALIDATION_FAILURE_KINDS = new Set<ModuleValidationFailureKind>([
  "incomplete_output",
  "merge_failed",
  "module_framework_failed",
  "module_input_failed",
  "module_visual_failed",
]);

const normalizeModuleFailureKind = (
  value: unknown,
): ModuleValidationFailureKind =>
  typeof value === "string" &&
  MODULE_VALIDATION_FAILURE_KINDS.has(value as ModuleValidationFailureKind)
    ? (value as ModuleValidationFailureKind)
    : "merge_failed";

const getCachedInputTokens = (usage: { cached_input_tokens?: number } | null) =>
  Math.max(0, Number(usage?.cached_input_tokens ?? 0));

const getUncachedInputTokens = (
  usage: { cached_input_tokens?: number; input_tokens: number } | null,
) => {
  const inputTokens = Math.max(0, Number(usage?.input_tokens ?? 0));
  const cachedInputTokens = getCachedInputTokens(usage);
  return Math.max(0, inputTokens - cachedInputTokens);
};

export {
  getCachedInputTokens,
  getUncachedInputTokens,
  normalizeModuleFailureKind,
};
export type {
  ModuleAgentRunRecord,
  ModuleValidationFailureKind,
  ModuleValidationRun,
  ModuleValidationStat,
};
