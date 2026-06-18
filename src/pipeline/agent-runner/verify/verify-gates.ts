import { DIFF_RATIO_THRESHOLD } from "../../../config/index.js";

import type { VerifyResult } from "../../verify.js";

type QualityStatus = "pass" | "partial";

type QualityAssessment = {
  blockingIssues: string[];
  gateSummary: Record<string, unknown>;
  softIssues: string[];
  status: QualityStatus;
};

const formatPercent = (value: number) => (value * 100).toFixed(2);

const buildQualityAssessment = (
  verifyResult: VerifyResult,
  options: { diffRatioThreshold?: number } = {},
): QualityAssessment => {
  const diffRatioThreshold = options.diffRatioThreshold ?? DIFF_RATIO_THRESHOLD;
  const blockingIssues: string[] = [];
  const softIssues: string[] = [];
  const globalDiffPassed = verifyResult.diffRatio <= diffRatioThreshold;

  if (!globalDiffPassed) {
    softIssues.push(
      `diffRatio ${formatPercent(verifyResult.diffRatio)}% > ${formatPercent(diffRatioThreshold)}%`,
    );
  }

  const status: QualityStatus = softIssues.length ? "partial" : "pass";

  return {
    blockingIssues,
    gateSummary: {
      diffRatio: verifyResult.diffRatio,
      diffRatioThreshold,
      globalDiffPassed,
    },
    softIssues,
    status,
  };
};

export { buildQualityAssessment };
