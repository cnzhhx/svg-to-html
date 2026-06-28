
import { getDiffRatioThreshold } from "../../../config/index.js";
import { resolveSvgDesign } from "../../../core/design-resolve.js";
import {
  sessionStore,
  type Session,
  type SessionResult,
} from "../../../session-store.js";
import { verifyDesign, type VerifyResult } from "../../verify.js";
import type { VerifyMode } from "../../verify.js";
import { archiveSessionCheckpoint } from "../archive/checkpoint.js";

const buildVerifyStepResult = (
  session: Session,
  verifyResult: VerifyResult,
  design: { height: number; width: number },
): SessionResult => ({
  artifactDir: session.artifactDir,
  compareEntryPath: session.outputTarget.compareEntryPath,
  designWidth: design.width,
  designHeight: design.height,
  diffRatio: verifyResult.diffRatio,
  outputTarget: session.outputTarget,
  renderEntryPath: session.outputTarget.renderEntryPath,
  renderPngPath: verifyResult.renderPngPath,
  sourceEntryPath: session.outputTarget.sourceEntryPath,
  sourceRenderMode: verifyResult.sourceRenderMode,
  sourceBasis: verifyResult.sourceBasis,
  svgPngPath: verifyResult.svgPngPath,
  verifyMode: verifyResult.mode,
});

const runVerify = async (
  sessionId: string,
  svgPath: string,
  artifactDir: string,
  iteration?: number,
  manageNode = true,
  options: {
    mode?: VerifyMode;
    signal?: AbortSignal;
  } = {},
): Promise<VerifyResult> => {
  const iterLabel = iteration !== undefined ? ` (round ${iteration})` : "";
  const mode = options.mode ?? "full";
  if (manageNode) {
    sessionStore.startWorkflowNode(sessionId, "verify", {
      detail:
        iteration && iteration > 1
          ? `正在执行第 ${iteration} 轮${mode === "fast" ? "快速" : "完整"}视觉校验`
          : `正在执行首轮${mode === "fast" ? "快速" : "完整"}视觉校验`,
      iteration: iteration ?? 1,
    });
  } else {
    sessionStore.setWorkflowMeta(sessionId, {
      detail:
        iteration && iteration > 1
          ? `后续修复中：第 ${iteration} 轮${mode === "fast" ? "快速" : "完整"}视觉校验`
          : `正在执行${mode === "fast" ? "快速" : "完整"}视觉校验`,
      iteration: iteration ?? 1,
    });
  }
  sessionStore.startStep(sessionId, "verify");
  sessionStore.addLog(
    sessionId,
    `[pipeline] starting ${mode} verify pass${iterLabel}`,
  );
  const currentSession = sessionStore.get(sessionId);
  if (!currentSession) throw new Error("Session not found");
  const scale = currentSession.scale;
  const verifiedDesign = await resolveSvgDesign(svgPath, { scale });
  const verifyResult = await verifyDesign(
    verifiedDesign.svgPath,
    (message) => {
      sessionStore.addLog(sessionId, `[verify] ${message}`);
    },
    artifactDir,
    {
      mode,
      renderEntryPath: currentSession.outputTarget.renderEntryPath,
      scale,
      signal: options.signal,
    },
  );
  const session = sessionStore.get(sessionId);
  if (!session) throw new Error("Session not found");

  const verifyStepResult = buildVerifyStepResult(
    session,
    verifyResult,
    verifiedDesign,
  );

  await archiveSessionCheckpoint({
    sessionId,
    round: iteration ?? 1,
    stage: "verify",
    diffRatio: verifyResult.diffRatio,
    note: `Verify pass ${iteration ?? 1}`,
    metadata: {
      diffRatio: verifyResult.diffRatio,
      mode: verifyResult.mode,
    },
    materials: [
      {
        kind: "file",
        label: "Rendered SVG PNG",
        sourcePath: verifyResult.svgPngPath,
        optional: true,
      },
      {
        kind: "file",
        label: "Rendered Output PNG",
        sourcePath: verifyResult.renderPngPath,
        optional: true,
      },

      {
        kind: "file",
        label: "Render Entry Snapshot",
        sourcePath: session.outputTarget.renderEntryPath,
        optional: true,
      },
      {
        kind: "json",
        label: "Verify Summary",
        targetName: "summary.json",
        payload: verifyStepResult,
      },
    ],
  });

  const diffRatioThreshold = getDiffRatioThreshold();
  if (verifyResult.diffRatio > diffRatioThreshold) {
    sessionStore.addLog(
      sessionId,
      `[pipeline] verify note (diff-ratio)${iterLabel}: diff=${(verifyResult.diffRatio * 100).toFixed(2)}%, threshold=${(diffRatioThreshold * 100).toFixed(2)}%`,
    );
  }

  sessionStore.addLog(
    sessionId,
    `[pipeline] ${mode} verify complete${iterLabel}: diff=${(verifyResult.diffRatio * 100).toFixed(2)}%`,
  );
  if (manageNode) {
    sessionStore.completeWorkflowNode(
      sessionId,
      "verify",
      `${mode === "fast" ? "快速" : "完整"}视觉校验完成，当前 diff ${(verifyResult.diffRatio * 100).toFixed(2)}%`,
    );
  } else {
    sessionStore.setWorkflowMeta(sessionId, {
      detail: `后续修复中：第 ${iteration ?? 1} 轮${mode === "fast" ? "快速" : "完整"}校验完成，diff ${(verifyResult.diffRatio * 100).toFixed(2)}%`,
      iteration: iteration ?? 1,
    });
  }
  sessionStore.completeStep(sessionId, "verify", verifyStepResult);

  return verifyResult;
};

export { runVerify };
