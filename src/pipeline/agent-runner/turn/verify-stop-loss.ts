import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const VERIFY_STOP_LOSS_DIFF_THRESHOLD = 0.05;
const VERIFY_STOP_LOSS_MIN_TURN_MS = 15 * 60 * 1000;
const VERIFY_STOP_LOSS_MIN_IMPROVEMENT = 0.001;
const VERIFY_STOP_LOSS_STATE_FILE = ".verify-stop-loss.json";

type VerifyStopLossSample = {
  diffRatio: number;
  round: number;
};

type VerifyStopLossRecommendation = {
  bestDiffRatio: number;
  improvements: [number, number];
  message: string;
  minImprovement: number;
  reason: "verify-low-improvement-soft-stop";
  turnDurationMs: number;
};

type VerifyStopLossState = {
  samples: VerifyStopLossSample[];
  turnStartedAt: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const normalizeVerifyStopLossSamples = (
  value: unknown,
): VerifyStopLossSample[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!isRecord(entry)) return undefined;
      const round = Number(entry["round"]);
      const diffRatio = Number(entry["diffRatio"]);
      if (
        !Number.isInteger(round) ||
        round < 0 ||
        !Number.isFinite(diffRatio)
      ) {
        return undefined;
      }
      return { diffRatio, round };
    })
    .filter((entry): entry is VerifyStopLossSample => Boolean(entry));
};

const parseVerifyStopLossHistory = (value: string | undefined) => {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => {
      const [roundRaw, diffRaw] = entry.split(":");
      const round = Number(roundRaw);
      const diffRatio = Number(diffRaw);
      if (
        !Number.isInteger(round) ||
        round <= 0 ||
        !Number.isFinite(diffRatio)
      ) {
        return undefined;
      }
      return { diffRatio, round };
    })
    .filter((entry): entry is VerifyStopLossSample => Boolean(entry));
};

const serializeVerifyStopLossHistory = (samples: VerifyStopLossSample[]) =>
  samples
    .map((sample) => `${sample.round}:${sample.diffRatio.toFixed(8)}`)
    .join(",");

const parseVerifyStopLossTurnStartedAt = (value: string | undefined) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Date.now();
};

const getVerifyStopLossStatePath = (moduleDir: string) =>
  path.join(moduleDir, VERIFY_STOP_LOSS_STATE_FILE);

const readVerifyStopLossState = async (
  moduleDir: string,
): Promise<VerifyStopLossState | undefined> => {
  try {
    const parsed = JSON.parse(
      await readFile(getVerifyStopLossStatePath(moduleDir), "utf8"),
    ) as unknown;
    if (!isRecord(parsed)) return undefined;
    const turnStartedAt = parseVerifyStopLossTurnStartedAt(
      typeof parsed["turnStartedAt"] === "number" ||
        typeof parsed["turnStartedAt"] === "string"
        ? String(parsed["turnStartedAt"])
        : undefined,
    );
    return {
      samples: normalizeVerifyStopLossSamples(parsed["samples"]),
      turnStartedAt,
    };
  } catch {
    return undefined;
  }
};

const writeVerifyStopLossState = async ({
  moduleDir,
  samples,
  turnStartedAt,
}: VerifyStopLossState & { moduleDir: string }) => {
  await writeFile(
    getVerifyStopLossStatePath(moduleDir),
    `${JSON.stringify(
      {
        samples,
        turnStartedAt,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
};

const buildVerifyStopLossRecommendation = ({
  now,
  samples,
  turnStartedAt,
}: {
  now: number;
  samples: VerifyStopLossSample[];
  turnStartedAt: number;
}): VerifyStopLossRecommendation | undefined => {
  if (samples.length < 3) return undefined;
  const turnDurationMs = now - turnStartedAt;
  if (turnDurationMs < VERIFY_STOP_LOSS_MIN_TURN_MS) return undefined;

  const bestDiffRatio = Math.min(...samples.map((sample) => sample.diffRatio));
  if (bestDiffRatio >= VERIFY_STOP_LOSS_DIFF_THRESHOLD) return undefined;

  const recentSamples = samples.slice(-3);
  const thirdLast = recentSamples[0];
  const secondLast = recentSamples[1];
  const last = recentSamples[2];
  if (!thirdLast || !secondLast || !last) return undefined;
  const firstImprovement = thirdLast.diffRatio - secondLast.diffRatio;
  const secondImprovement = secondLast.diffRatio - last.diffRatio;
  if (
    firstImprovement >= VERIFY_STOP_LOSS_MIN_IMPROVEMENT ||
    secondImprovement >= VERIFY_STOP_LOSS_MIN_IMPROVEMENT
  ) {
    return undefined;
  }

  return {
    bestDiffRatio,
    improvements: [firstImprovement, secondImprovement],
    message:
      "当前最佳 diffRatio 已低于 5%，本轮执行超过 15 分钟，且连续两次 verify 改善都小于 0.1 个百分点。请停止继续微调本模块，保留当前最佳版本并结束本轮。",
    minImprovement: VERIFY_STOP_LOSS_MIN_IMPROVEMENT,
    reason: "verify-low-improvement-soft-stop",
    turnDurationMs,
  };
};

export {
  VERIFY_STOP_LOSS_DIFF_THRESHOLD,
  VERIFY_STOP_LOSS_MIN_IMPROVEMENT,
  VERIFY_STOP_LOSS_MIN_TURN_MS,
  buildVerifyStopLossRecommendation,
  parseVerifyStopLossHistory,
  parseVerifyStopLossTurnStartedAt,
  readVerifyStopLossState,
  serializeVerifyStopLossHistory,
  writeVerifyStopLossState,
};
export type {
  VerifyStopLossRecommendation,
  VerifyStopLossSample,
  VerifyStopLossState,
};
