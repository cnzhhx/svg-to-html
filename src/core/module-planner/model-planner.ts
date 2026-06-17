import { existsSync } from "node:fs";
import path from "node:path";

import type { AgentThread } from "../../pipeline/agent-runtime/index.js";
import {
  getThreadOptions,
  startAgentThread,
} from "../../pipeline/llm-client.js";
import { AGENT_REASONING_EFFORTS } from "../../config/agent-reasoning.js";
import { writeJsonFile, writeTextFile } from "../utils.js";
import { normalizeModelPlan } from "./normalize-plan.js";
import type {
  ModelPlannerInput,
  ModelPlannerRequest,
  ModelPlannerResponse,
  ModulePlanValidationIssue,
  ModulePlanValidationResult,
  ModulePlanValidationSummary,
} from "./types.js";
import {
  collectValidationSourceBoxes,
  parseModelPlannerResponse,
  validateModelPlan,
} from "./validate-plan.js";
import type { PlannedModules } from "../svg-vertical-modules/types.js";
import { buildInitialPrompt, buildRetryPrompt } from "../../prompts/planner.js";

const DEFAULT_PLANNER_TURN_TIMEOUT_MS = 10 * 60 * 1000;

const getPlannerTurnTimeoutMs = () => {
  const raw = Number(
    process.env["MODEL_PLANNER_TURN_TIMEOUT_MS"] ??
      DEFAULT_PLANNER_TURN_TIMEOUT_MS,
  );
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_PLANNER_TURN_TIMEOUT_MS;
  }
  return Math.floor(raw);
};

type ModelPlannerSuccess = {
  attemptCount: number;
  planned: PlannedModules;
  request: ModelPlannerRequest;
  response: ModelPlannerResponse;
  status: "success";
  validation: ModulePlanValidationResult;
};

type ModelPlannerFailure = {
  attemptCount: number;
  failureReason: string;
  request: ModelPlannerRequest;
  response?: unknown;
  status: "failed";
  validation?: ModulePlanValidationResult;
};

type ModelPlannerResult = ModelPlannerFailure | ModelPlannerSuccess;

const toValidationSummary = (
  validation: ModulePlanValidationResult,
): ModulePlanValidationSummary => ({
  errorCount: validation.errorCount,
  errors: validation.errors.slice(0, 20),
  passed: validation.passed,
  warningCount: validation.warningCount,
  warnings: validation.warnings.slice(0, 20),
});

const validationFromIssue = (
  issue: ModulePlanValidationIssue,
): ModulePlanValidationResult => ({
  errorCount: issue.severity === "error" ? 1 : 0,
  errors: issue.severity === "error" ? [issue] : [],
  passed: issue.severity !== "error",
  warningCount: issue.severity === "warning" ? 1 : 0,
  warnings: issue.severity === "warning" ? [issue] : [],
});

const createGeometryHints = (input: ModelPlannerInput) => {
  const sourceBoxes = collectValidationSourceBoxes({
    containerLayout: input.containerLayout,
    viewport: input.viewport,
  });

  return {
    note: "Use these boxes to avoid obvious container cuts, but coordinates may be approximate: choose semantic rough regions and let deterministic post-processing snap pixel boundaries. Do not return one full-page module just to avoid pixel-risk validation issues.",
    sourceBoxes: sourceBoxes.slice(0, 160).map((sourceBox) => ({
      box: sourceBox.box,
      id: sourceBox.id,
      kind: sourceBox.kind,
    })),
  };
};

const createRequest = (
  input: ModelPlannerInput,
): ModelPlannerRequest => ({
  constraints: input.constraints,
  design: input.design,
  geometryHints: createGeometryHints(input),
  mode: input.mode,
});


const writeValidationArtifact = async ({
  moduleDir,
  validation,
}: {
  moduleDir: string;
  validation: ModulePlanValidationResult;
}) =>
  writeJsonFile(path.join(moduleDir, "planner-validation.json"), {
    ...toValidationSummary(validation),
    sourceCoverage: validation.sourceCoverage,
  });

const writeRetryArtifact = async ({
  attempt,
  moduleDir,
  validation,
}: {
  attempt: number;
  moduleDir: string;
  validation: ModulePlanValidationResult;
}) =>
  writeJsonFile(
    path.join(
      moduleDir,
      `planner-retry-${String(attempt).padStart(2, "0")}.json`,
    ),
    {
      errors: validation.errors.slice(0, 20),
      request:
        attempt >= 2
          ? "只返回修正后的 JSON。请使用更稳定、边界更安全、大小更均衡的模块区域。"
          : "只返回修正后的 JSON。保持语义 section 完整，并避开失败的边界。",
      validationFailed: true,
      warnings: validation.warnings.slice(0, 12),
    },
  );

const writeResponseArtifacts = async ({
  moduleDir,
  parsed,
  raw,
}: {
  moduleDir: string;
  parsed: ReturnType<typeof parseModelPlannerResponse>;
  raw: string;
}) => {
  await writeTextFile(path.join(moduleDir, "planner-response.raw.txt"), raw);
  await writeJsonFile(
    path.join(moduleDir, "planner-response.json"),
    parsed.response ?? {
      jsonText: parsed.jsonText,
      parseError: parsed.error?.message ?? "unknown parse error",
    },
  );
};

const runPlannerTurn = async ({
  attempt,
  imagePaths,
  moduleDir,
  prompt,
  thread,
}: {
  attempt: number;
  imagePaths?: string[];
  moduleDir: string;
  prompt: string;
  thread: AgentThread;
}) => {
  await writeTextFile(
    path.join(
      moduleDir,
      `planner-prompt-${String(attempt).padStart(2, "0")}.txt`,
    ),
    prompt,
  );
  const mockResponse = process.env["MODEL_PLANNER_MOCK_RESPONSE"];
  if (mockResponse !== undefined) return mockResponse;

  const timeoutMs = getPlannerTurnTimeoutMs();
  const timeoutReason = `Module planner turn timed out after ${timeoutMs}ms`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(timeoutReason);
  }, timeoutMs);

  try {
    const turn = imagePaths?.length
      ? await thread.run(
          [
            { type: "text", text: prompt },
            ...imagePaths.map((imagePath) => ({
              type: "local_image" as const,
              path: imagePath,
            })),
          ],
          { signal: controller.signal },
        )
      : await thread.run(prompt, { signal: controller.signal });
    return turn.finalResponse ?? "";
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason === timeoutReason) {
      throw new Error(timeoutReason);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
};

const runModelPlanner = async (
  input: ModelPlannerInput,
): Promise<ModelPlannerResult> => {
  const request = createRequest(input);
  await writeJsonFile(
    path.join(input.moduleDir, "planner-request.json"),
    request,
  );

  const thread = startAgentThread(
    {
      ...getThreadOptions("vision"),
      additionalDirectories: [
        input.artifactDir,
        path.dirname(input.design.sourceSvgPath),
      ].filter((directory) => existsSync(directory)),
      modelReasoningEffort: AGENT_REASONING_EFFORTS.support,
      networkAccessEnabled: false,
      sandboxMode: "read-only",
      runtimeTraceDir: path.join(
        input.artifactDir,
        "runtime-traces",
        "module-planner",
      ),
      runtimeTraceLabel: "module-planner",
      webSearchEnabled: false,
      webSearchMode: "disabled",
      workingDirectory: process.cwd(),
    },
    { modelRole: "vision" },
  );

  let latestValidation: ModulePlanValidationResult | undefined;
  let latestResponse: unknown;
  const totalAttempts = Math.max(1, Math.floor(input.plannerRetries) + 1);

  try {
    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      const raw = await runPlannerTurn({
        attempt,
        imagePaths:
          attempt === 1
            ? (input.design.previewImages?.map((image) => image.imagePath) ?? [
                input.design.previewImagePath,
              ])
            : undefined,
        moduleDir: input.moduleDir,
        prompt:
          attempt === 1
            ? buildInitialPrompt(request)
            : buildRetryPrompt({
                attempt: attempt - 1,
                validation: latestValidation!,
              }),
        thread,
      });
      const parsed = parseModelPlannerResponse(raw);
      latestResponse = parsed.response;
      await writeResponseArtifacts({
        moduleDir: input.moduleDir,
        parsed,
        raw,
      });

      const validation = parsed.error
        ? validationFromIssue(parsed.error)
        : validateModelPlan({
            containerLayout: input.containerLayout,
            response: parsed.response,
            viewport: input.viewport,
          });
      latestValidation = validation;
      await writeValidationArtifact({
        moduleDir: input.moduleDir,
        validation,
      });

      if (validation.passed) {
        const response = parsed.response as ModelPlannerResponse;
        return {
          attemptCount: attempt,
          planned: normalizeModelPlan({
            containerLayout: input.containerLayout,
            response,
            svgLayout: input.svgLayout,
            validation,
            viewport: input.viewport,
          }),
          request,
          response,
          status: "success",
          validation,
        };
      }

      if (attempt < totalAttempts) {
        await writeRetryArtifact({
          attempt,
          moduleDir: input.moduleDir,
          validation,
        });
      }
    }

    return {
      attemptCount: totalAttempts,
      failureReason: `Model planner validation failed after ${totalAttempts} attempt(s): ${
        latestValidation?.errors
          .slice(0, 3)
          .map((issue) => issue.message)
          .join("; ") || "unknown validation error"
      }`,
      request,
      response: latestResponse,
      status: "failed",
      validation: latestValidation,
    };
  } catch (error) {
    return {
      attemptCount: Math.max(1, totalAttempts),
      failureReason: `Model planner failed: ${error instanceof Error ? error.message : String(error)}`,
      request,
      response: latestResponse,
      status: "failed",
      validation: latestValidation,
    };
  }
};

export { runModelPlanner, toValidationSummary };
