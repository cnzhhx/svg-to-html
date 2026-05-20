import { DIFF_RATIO_THRESHOLD } from "../../config/runtime.js";

import type { VerifyResult } from "../verify.js";

type QualityStatus = "pass" | "partial" | "fail";

type QualityAssessment = {
  blockingIssues: string[];
  gateSummary: Record<string, unknown>;
  softIssues: string[];
  status: QualityStatus;
};

const formatPercent = (value: number) => (value * 100).toFixed(2);

const getModuleDomReconcileFailure = (verifyResult: VerifyResult) => {
  const reconcile = verifyResult.moduleDomReconcileSummary;
  if (!reconcile || (reconcile.passed && reconcile.issueCount <= 0))
    return null;
  return `module DOM reconcile failed (missing=${reconcile.missingDomModuleIds.length}, duplicate=${reconcile.duplicateDomModuleIds.length}, unplanned=${reconcile.unplannedDomModuleIds.length})`;
};

const getHardVerifyGateFailures = (verifyResult: VerifyResult) => {
  const failures: string[] = [];

  if (!verifyResult.layoutBoxPassed) failures.push("layout-box gate failed");
  if (!verifyResult.workflowLintPassed)
    failures.push("workflow-lint gate failed");
  if (verifyResult.finalOutputPolicyPassed === false) {
    failures.push("final-output-policy gate failed");
  }
  if ((verifyResult.textPriorityIssueCount ?? 0) > 0) {
    failures.push(
      `text priority gate failed (${verifyResult.textPriorityIssueCount} issue(s))`,
    );
  }

  const reconcileFailure = getModuleDomReconcileFailure(verifyResult);
  if (reconcileFailure) failures.push(reconcileFailure);

  return failures;
};

const buildQualityAssessment = (
  verifyResult: VerifyResult,
  options: { diffRatioThreshold?: number } = {},
): QualityAssessment => {
  const diffRatioThreshold = options.diffRatioThreshold ?? DIFF_RATIO_THRESHOLD;
  const blockingIssues = getHardVerifyGateFailures(verifyResult);
  const softIssues: string[] = [];
  const globalDiffPassed =
    verifyResult.diffRatio <= diffRatioThreshold ||
    Boolean(verifyResult.fontRenderingLimitLikely);
  const textPriorityIssueCount = verifyResult.textPriorityIssueCount ?? 0;
  const textGeometryPriorityIssueCount =
    verifyResult.textGeometryPriorityIssueCount ?? 0;
  const textContentPriorityIssueCount =
    verifyResult.textContentPriorityIssueCount ?? 0;

  if (!globalDiffPassed) {
    softIssues.push(
      `diffRatio ${formatPercent(verifyResult.diffRatio)}% > ${formatPercent(diffRatioThreshold)}%`,
    );
  }
  if (verifyResult.moduleRegionDiffPassed === false) {
    const failedModules = verifyResult.moduleRegionDiffFailures
      ?.map((stat) => `${stat.id}=${formatPercent(stat.diffRatio)}%`)
      .join(", ");
    softIssues.push(
      `module-region-diff quality issue${failedModules ? ` (${failedModules})` : ""}`,
    );
  }
  if (textPriorityIssueCount > 0 && blockingIssues.length === 0) {
    softIssues.push(
      `text priority issues: ${textPriorityIssueCount} (content=${textContentPriorityIssueCount}, geometry=${textGeometryPriorityIssueCount})`,
    );
  }

  const status: QualityStatus = blockingIssues.length
    ? "fail"
    : softIssues.length
      ? "partial"
      : "pass";

  return {
    blockingIssues,
    gateSummary: {
      diffRatio: verifyResult.diffRatio,
      diffRatioThreshold,
      finalOutputPolicyPassed: verifyResult.finalOutputPolicyPassed !== false,
      fontRenderingLimitLikely: Boolean(verifyResult.fontRenderingLimitLikely),
      globalDiffPassed,
      layoutBoxPassed: verifyResult.layoutBoxPassed,
      moduleDomReconcilePassed:
        !verifyResult.moduleDomReconcileSummary ||
        (verifyResult.moduleDomReconcileSummary.passed &&
          verifyResult.moduleDomReconcileSummary.issueCount <= 0),
      moduleRegionDiffPassed: verifyResult.moduleRegionDiffPassed !== false,
      moduleRegionDiffThreshold: verifyResult.moduleRegionDiffThreshold,
      textContentPriorityIssueCount,
      textGeometryPriorityIssueCount,
      textPriorityIssueCount,
      workflowLintPassed: verifyResult.workflowLintPassed,
    },
    softIssues,
    status,
  };
};

export { buildQualityAssessment, getHardVerifyGateFailures };
