import { existsSync } from "node:fs";
import path from "node:path";

import type { AgentThread } from "../../pipeline/agent-runtime/index.js";
import { startAgentThread, threadOptions } from "../../pipeline/llm-client.js";
import { writeJsonFile, writeTextFile } from "../utils.js";
import { normalizeCodexPlan } from "./normalize-plan.js";
import type {
  CodexModulePlannerInput,
  CodexPlannerRequest,
  CodexPlannerResponse,
  ModulePlanValidationIssue,
  ModulePlanValidationResult,
  ModulePlanValidationSummary,
} from "./types.js";
import {
  collectValidationSourceBoxes,
  parseCodexPlannerResponse,
  validateCodexPlan,
} from "./validate-plan.js";
import type { PlannedModules } from "../svg-vertical-modules/types.js";

type CodexPlannerSuccess = {
  attemptCount: number;
  planned: PlannedModules;
  request: CodexPlannerRequest;
  response: CodexPlannerResponse;
  status: "success";
  validation: ModulePlanValidationResult;
};

type CodexPlannerFailure = {
  attemptCount: number;
  failureReason: string;
  request: CodexPlannerRequest;
  response?: unknown;
  status: "failed";
  validation?: ModulePlanValidationResult;
};

type CodexPlannerResult = CodexPlannerFailure | CodexPlannerSuccess;

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

const createGeometryHints = (input: CodexModulePlannerInput) => {
  const sourceBoxes = collectValidationSourceBoxes({
    containerLayout: input.containerLayout,
    ocrBlocks: input.ocrBlocks,
    shellManifest: input.shellManifest,
    viewport: input.viewport,
  });

  return {
    note: "Use these boxes to avoid obvious text/container cuts, but coordinates may be approximate: choose semantic rough regions and let deterministic post-processing snap pixel boundaries. Do not return one full-page module just to avoid pixel-risk feedback.",
    ocrBlocks: input.ocrBlocks.slice(0, 120).map((block) => ({
      bbox: block.bbox,
      id: block.id,
      text: block.text?.slice(0, 80),
    })),
    sourceBoxes: sourceBoxes.slice(0, 160).map((sourceBox) => ({
      box: sourceBox.box,
      id: sourceBox.id,
      kind: sourceBox.kind,
    })),
  };
};

const createRequest = (
  input: CodexModulePlannerInput,
): CodexPlannerRequest => ({
  constraints: input.constraints,
  design: input.design,
  geometryHints: createGeometryHints(input),
  mode: input.mode,
});

const buildInitialPrompt = (
  request: CodexPlannerRequest,
) => `你是 SVG 转 HTML 还原流水线里的”模块拆分规划器”。

你的任务：查看随附的设计预览图，输出一个符合语义结构的模块区域规划。
如果随附多张图片，它们是原设计的局部切片；每张 tile 的 offsetY/height 已写在规划输入里。所有输出坐标仍必须使用原设计稿的全局像素坐标系，不要使用 tile 局部坐标。

核心原则：模块粒度以完整的结构父容器、视觉边界和内容职责为准，不以元素数量或子项数量为准。只有当相邻内容在布局节奏、背景/层级、分隔边界或交互职责上明显独立时，才拆成多个模块；同一父容器内的重复项、连续项、成组项或矩阵项应保留在同一模块中，由下游在模块内部表达其子结构。

规则：
- 只返回 JSON，不要输出 markdown 代码块，也不要输出解释性文字。
- 坐标必须使用原设计稿的全局像素坐标系。
- 按结构层级切模块：一个模块应对应一个完整的视觉/语义区域，而不是按固定宽高切。
- 判断模块边界时，优先看背景/层级变化、留白间隔、分割线、区域标识与关联内容组、成组容器、固定/浮动区域等通用结构信号。
- 跨主要内容持续存在、且视觉上独立的固定/共享结构，应作为独立模块。
- 如果两个相邻区域之间存在明确的区域标识分隔、背景/层级变化、明显留白或分割线，它们就是不同的模块。
- 一个“区域标识/说明/控制 + 其关联内容组”是模块的最小语义单元；不要把多个这样的单元合并成一个大模块。
- 重复项、连续项、行列项、矩阵项等应保留完整的父容器；除非视觉上已经分成多个独立区域，否则不要从中间切开。
- 固定/浮动元素如果具有独立结构职责，应作为独立模块。
- 模块可以是横向区域、纵向区域，也可以是非全宽的二维区域；不要因为形状狭长就否定它。
- 不要为了”保守”把多个明显不同的视觉区域合成一个巨大模块；如果区域之间有清晰视觉边界，应该拆开。
- 边界应尽量落在空白、分割线或背景自然断点处，不要切穿可见文字、重复/连续内容项、控件组或结构背景块。
- 小型图形、局部装饰、状态标记、局部纹理或局部形状，应归入最近的结构父模块，不要单独成模块。
- 不要创建很小的纯装饰性模块。
- 对长页面/多 tile 输入，不要返回一个覆盖整页的单一模块；每个明显独立的结构父容器、连续内容组、固定/浮动区域都应拆成独立模块。
- 你不需要做到像素级精确；请给语义上正确的粗边界，系统会自动把边界吸附到最近 OCR/container/SVG 安全位置。不要为了躲避像素误差把页面合成一个整页模块。

必须返回下面这种 JSON 结构：
{
  "strategy": "semantic-visual",
  "modules": [
    {
      "id": "module-01",
      "kind": "section",
      "region": { "x": 0, "y": 0, "width": 1500, "height": 900 },
      "reason": "简短说明"
    }
  ]
}

kind 只能使用这些值：global-shell, section, header, sidebar, main, right-panel, list-grid, overlay, model-region。

规划输入：
${JSON.stringify(request, null, 2)}
`;

const buildFeedbackPrompt = ({
  attempt,
  validation,
}: {
  attempt: number;
  validation: ModulePlanValidationResult;
}) => `你上一次返回的模块区域 JSON 没有通过校验。

请只返回修正后的 JSON。保持语义 section 完整，减少高风险边界，避开下面失败的切分位置。
如果页面很高，不要为了避开贯穿背景/大装饰容器而合并成超高模块；贯穿多个 section 的背景应归入相邻主模块或作为背景处理，语义内容仍需按视觉 section、列表/网格父容器、页脚等拆分。
如果只是边界存在几十像素级偏差，不要改成整页大模块；继续保留语义拆分，给出更接近安全位置的粗边界即可，宿主程序会自动吸附。
${attempt >= 2 ? "这是最后一次重试；请使用更稳定、边界更安全、大小更均衡的模块区域。" : ""}

校验错误：
${JSON.stringify(validation.errors.slice(0, 20), null, 2)}

校验警告：
${JSON.stringify(validation.warnings.slice(0, 12), null, 2)}
`;

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

const writeFeedbackArtifact = async ({
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
      `planner-feedback-${String(attempt).padStart(2, "0")}.json`,
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
  parsed: ReturnType<typeof parseCodexPlannerResponse>;
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
  const mockResponse = process.env["CODEX_MODULE_PLANNER_MOCK_RESPONSE"];
  if (mockResponse !== undefined) return mockResponse;

  const turn = imagePaths?.length
    ? await thread.run([
        { type: "text", text: prompt },
        ...imagePaths.map((imagePath) => ({
          type: "local_image" as const,
          path: imagePath,
        })),
      ])
    : await thread.run(prompt);
  return turn.finalResponse ?? "";
};

const runCodexModulePlanner = async (
  input: CodexModulePlannerInput,
): Promise<CodexPlannerResult> => {
  const request = createRequest(input);
  await writeJsonFile(
    path.join(input.moduleDir, "planner-request.json"),
    request,
  );

  const thread = startAgentThread({
    ...threadOptions,
    additionalDirectories: [
      input.artifactDir,
      path.dirname(input.design.sourceSvgPath),
    ].filter((directory) => existsSync(directory)),
    networkAccessEnabled: false,
    sandboxMode: "read-only",
    webSearchEnabled: false,
    webSearchMode: "disabled",
    workingDirectory: process.cwd(),
  });

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
            : buildFeedbackPrompt({
                attempt: attempt - 1,
                validation: latestValidation!,
              }),
        thread,
      });
      const parsed = parseCodexPlannerResponse(raw);
      latestResponse = parsed.response;
      await writeResponseArtifacts({
        moduleDir: input.moduleDir,
        parsed,
        raw,
      });

      const validation = parsed.error
        ? validationFromIssue(parsed.error)
        : validateCodexPlan({
            containerLayout: input.containerLayout,
            ocrBlocks: input.ocrBlocks,
            response: parsed.response,
            shellManifest: input.shellManifest,
            viewport: input.viewport,
          });
      latestValidation = validation;
      await writeValidationArtifact({
        moduleDir: input.moduleDir,
        validation,
      });

      if (validation.passed) {
        const response = parsed.response as CodexPlannerResponse;
        return {
          attemptCount: attempt,
          planned: normalizeCodexPlan({
            containerLayout: input.containerLayout,
            ocrBlocks: input.ocrBlocks,
            response,
            shellManifest: input.shellManifest,
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
        await writeFeedbackArtifact({
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

export { runCodexModulePlanner, toValidationSummary };
export type { CodexPlannerResult };
