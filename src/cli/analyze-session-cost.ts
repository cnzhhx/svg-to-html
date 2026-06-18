import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { isString } from "../core/type-guards.js";
import { getWorkspaceRoot } from "../core/paths.js";
import { isRecord } from "../core/type-guards.js";
import {
  writeJsonFile,
  writeTextFile,
} from "../core/file-io.js";
import { parseCliFlags } from "./cli-utils.js";

type JsonRecord = Record<string, unknown>;

const VALUE_FLAGS = new Set(["--output-dir"]);

const asNumber = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const asArray = (value: unknown): JsonRecord[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const asUnknownArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

const readJsonIfExists = async <T = unknown>(filePath: string) => {
  if (!existsSync(filePath)) return null;
  return JSON.parse(await readFile(filePath, "utf8")) as T;
};

const parseArgs = (args: string[]) => {
  const { flags, positionals } = parseCliFlags(args, VALUE_FLAGS);
  return { outputDir: flags.get("--output-dir"), paths: positionals };
};

const resolveSessionDir = (input: string) => {
  const direct = path.resolve(input);
  if (existsSync(path.join(direct, "session.json"))) return direct;

  const byId = path.join(getWorkspaceRoot(), "sessions", input);
  if (existsSync(path.join(byId, "session.json"))) return byId;

  throw new Error(`Unable to locate session.json for ${input}`);
};

const discoverSessionDirs = async () => {
  const sessionsRoot = path.join(getWorkspaceRoot(), "sessions");
  const entries = await readdir(sessionsRoot, { withFileTypes: true }).catch(
    () => [],
  );
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(sessionsRoot, entry.name))
    .filter((dir) => existsSync(path.join(dir, "session.json")));
};

const formatSeconds = (ms: number | undefined) =>
  ms === undefined ? "n/a" : `${(ms / 1000).toFixed(1)}s`;

const formatPercent = (value: number | undefined) =>
  value === undefined ? "n/a" : `${(value * 100).toFixed(2)}%`;

const sum = (values: Array<number | undefined>) =>
  values.reduce<number>((total, value) => total + (value ?? 0), 0);

const getPath = (value: unknown, keys: string[]) => {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
};

const LEGACY_MODULES_NEEDING_RETRY_KEY = [
  "modules",
  "Needing",
  "Feed",
  "back",
].join("");

const getDiffValue = (run: JsonRecord) => {
  const timeline = asArray(
    getPath(run, ["turnSummary", "internalDiffTimeline"]),
  );
  const lastTimelineDiff = asNumber(timeline.at(-1)?.diffRatio);
  return (
    lastTimelineDiff ??
    asNumber(run.finalDiffRatio)
  );
};

const getRunImprovement = (run: JsonRecord) => {
  const timeline = asArray(
    getPath(run, ["turnSummary", "internalDiffTimeline"]),
  );
  if (timeline.length >= 2) {
    const first = asNumber(timeline[0]?.diffRatio);
    const last = asNumber(timeline.at(-1)?.diffRatio);
    if (first !== undefined && last !== undefined) return first - last;
  }
  return undefined;
};

const readWorkflowArchives = async (
  session: JsonRecord,
  artifactDir: string,
) => {
  const fromSession = asArray(getPath(session, ["result", "workflowArchives"]));
  if (fromSession.length) return fromSession;
  const history = await readJsonIfExists<JsonRecord>(
    path.join(artifactDir, "workflow-history", "manifest.json"),
  );
  return asArray(history?.entries);
};

const analyzeSession = async (sessionDir: string, outputDir?: string) => {
  const session = (await readJsonIfExists<JsonRecord>(
    path.join(sessionDir, "session.json"),
  )) ?? { id: path.basename(sessionDir) };
  const artifactDir =
    (isString(session.artifactDir) ? session.artifactDir : undefined) ??
    path.join(sessionDir, "artifacts");
  const moduleAgentManifest =
    (await readJsonIfExists<JsonRecord>(
      path.join(artifactDir, "modules", "module-agent-manifest.json"),
    )) ?? {};

  const runs =
    asArray(moduleAgentManifest.runs).length > 0
      ? asArray(moduleAgentManifest.runs)
      : asArray(getPath(session, ["result", "moduleAgentRuns"]));
  const validationRuns =
    asArray(moduleAgentManifest.validationRuns).length > 0
      ? asArray(moduleAgentManifest.validationRuns)
      : asArray(getPath(session, ["result", "moduleValidationRuns"]));
  const workflowArchives = await readWorkflowArchives(session, artifactDir);
  const agentArchives = workflowArchives.filter(
    (entry) => entry.stage === "agent",
  );
  const verifyArchives = workflowArchives.filter(
    (entry) => entry.stage === "verify",
  );

  const moduleRuns = runs.map((run) => {
    const durationMs = asNumber(run.durationMs) ?? 0;
    const improvement = getRunImprovement(run);
    return {
      allowedAssetCount: asNumber(run.allowedAssetCount),
      diffAfter: getDiffValue(run),
      durationMs,
      id: String(run.id ?? "unknown"),
      improvement,
      inputTokens: asNumber(run.inputTokens) ?? 0,
      outputTokens: asNumber(run.outputTokens) ?? 0,
      promptKind: String(run.promptKind ?? "unknown"),
      round: asNumber(run.round) ?? 0,
      status: String(run.status ?? "unknown"),
      totalCommands:
        asNumber(getPath(run, ["turnSummary", "totalCommands"])) ?? 0,
      totalInternalRounds:
        asNumber(getPath(run, ["turnSummary", "totalInternalRounds"])) ?? 0,
      totalShellCommands:
        asNumber(getPath(run, ["turnSummary", "totalShellCommands"])) ?? 0,
      verifyCount: asNumber(getPath(run, ["turnSummary", "verifyCount"])) ?? 0,
    };
  });
  const modelUsageRecords = asArray(
    getPath(session, ["result", "modelUsageRecords"]),
  ).map((record) => ({
    cachedInputTokens: asNumber(record.cachedInputTokens) ?? 0,
    inputKind: String(record.inputKind ?? "unknown"),
    inputTokens: asNumber(record.inputTokens) ?? 0,
    model: String(record.model ?? "unknown"),
    modelConfigId: String(record.modelConfigId ?? "unknown"),
    modelRole: String(record.modelRole ?? "unknown"),
    outputTokens: asNumber(record.outputTokens) ?? 0,
    provider: String(record.provider ?? "unknown"),
    runtime: String(record.runtime ?? "unknown"),
    source: String(record.source ?? "unknown"),
    tokensUsed: asNumber(record.tokensUsed) ?? 0,
    uncachedInputTokens: asNumber(record.uncachedInputTokens) ?? 0,
  }));

  const totalAgentDurationMs =
    sum(moduleRuns.map((run) => run.durationMs)) +
    sum(
      agentArchives.map((entry) =>
        asNumber(getPath(entry, ["metadata", "durationMs"])),
      ),
    );
  const totalInputTokens =
    modelUsageRecords.length > 0
      ? sum(modelUsageRecords.map((record) => record.inputTokens))
      : sum(moduleRuns.map((run) => run.inputTokens));
  const totalCachedInputTokens = modelUsageRecords.length
    ? sum(modelUsageRecords.map((record) => record.cachedInputTokens))
    : undefined;
  const totalUncachedInputTokens = modelUsageRecords.length
    ? sum(modelUsageRecords.map((record) => record.uncachedInputTokens))
    : undefined;
  const totalOutputTokens = modelUsageRecords.length
    ? sum(modelUsageRecords.map((record) => record.outputTokens))
    : sum(moduleRuns.map((run) => run.outputTokens)) +
      sum(
        agentArchives.map((entry) =>
          asNumber(getPath(entry, ["metadata", "outputTokens"])),
        ),
      );
  const finalDiffRatio = asNumber(getPath(session, ["result", "diffRatio"]));
  const validationSummary = validationRuns.map((run) => ({
    diffRatio: asNumber(run.diffRatio),
    failedModuleIds: asUnknownArray(
      run.failedModuleIds ?? run[LEGACY_MODULES_NEEDING_RETRY_KEY],
    ).map(
      String,
    ),
    round: asNumber(run.round),
    scope: String(run.scope ?? "unknown"),
    threshold: asNumber(run.threshold),
  }));
  const bottlenecks = moduleRuns.flatMap((run) => {
    const issues: string[] = [];
    if (run.durationMs >= 300_000) issues.push("long module turn >=300s");
    if (run.inputTokens >= 1_000_000) issues.push("very high input tokens");
    if (
      run.durationMs >= 120_000 &&
      run.improvement !== undefined &&
      run.improvement < 0.002
    ) {
      issues.push("low diff improvement for time spent");
    }
    return issues.length ? [{ ...run, issues }] : [];
  });
  const report = {
    artifactDir,
    bottlenecks,
    final: {
      diffRatio: finalDiffRatio,
    },
    moduleRuns,
    modelUsageRecords,
    session: {
      designName: session.designName,
      id: session.id ?? path.basename(sessionDir),
      status: session.status,
      updatedAt: session.updatedAt,
    },
    totals: {
      agentArchiveCount: agentArchives.length,
      moduleRunCount: moduleRuns.length,
      modelUsageRecordCount: modelUsageRecords.length,
      totalAgentDurationMs,
      totalCachedInputTokens,
      totalInputTokens,
      totalOutputTokens,
      totalUncachedInputTokens,
      totalVerifyArchives: verifyArchives.length,
      totalVerifyCount: sum(moduleRuns.map((run) => run.verifyCount)),
    },
    validationRuns: validationSummary,
  };

  const targetDir = outputDir ? path.resolve(outputDir) : artifactDir;
  const jsonPath = path.join(targetDir, "session-cost-analysis.json");
  const markdownPath = path.join(targetDir, "session-cost-analysis.md");
  await writeJsonFile(jsonPath, report);
  await writeTextFile(
    markdownPath,
    [
      `# Session Cost Analysis`,
      "",
      `- session: ${report.session.id}`,
      `- design: ${report.session.designName ?? "n/a"}`,
      `- final diff: ${formatPercent(finalDiffRatio)}`,
      `- module runs: ${moduleRuns.length}`,
      `- total agent time: ${formatSeconds(totalAgentDurationMs)}`,
      `- total input tokens: ${totalInputTokens}`,
      totalCachedInputTokens !== undefined
        ? `- cached input tokens: ${totalCachedInputTokens}`
        : undefined,
      totalUncachedInputTokens !== undefined
        ? `- uncached input tokens: ${totalUncachedInputTokens}`
        : undefined,
      `- total output tokens: ${totalOutputTokens}`,
      "",
      ...(modelUsageRecords.length
        ? [
            "## Model Usage",
            "",
            "| source | kind | role | config | model | input | cached | uncached | output | total |",
            "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
            ...modelUsageRecords.map(
              (record) =>
                `| ${[
                  record.source,
                  record.inputKind,
                  record.modelRole,
                  record.modelConfigId,
                  record.model,
                  record.inputTokens,
                  record.cachedInputTokens,
                  record.uncachedInputTokens,
                  record.outputTokens,
                  record.tokensUsed,
                ].join(" | ")} |`,
            ),
            "",
          ]
        : []),
      "## Module Runs",
      "",
      "| module | round | kind | time | input | output | verify | diff after | improvement | commands | assets |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      ...moduleRuns.map(
        (run) =>
          `| ${[
            run.id,
            run.round,
            run.promptKind,
            formatSeconds(run.durationMs),
            run.inputTokens,
            run.outputTokens,
            run.verifyCount,
            formatPercent(run.diffAfter),
            formatPercent(run.improvement),
            run.totalCommands,
            run.allowedAssetCount ?? "n/a",
          ].join(" | ")} |`,
      ),
      "",
      "## Validation",
      "",
      "| round | scope | diff | threshold | failed modules |",
      "| --- | --- | --- | --- | --- |",
      ...validationSummary.map(
        (run) =>
          `| ${run.round ?? "n/a"} | ${run.scope} | ${formatPercent(run.diffRatio)} | ${formatPercent(run.threshold)} | ${run.failedModuleIds.join(", ") || "-"} |`,
      ),
      "",
      "## Bottlenecks",
      "",
      bottlenecks.length
        ? bottlenecks
            .map(
              (run) =>
                `- ${run.id} round ${run.round}: ${run.issues.join("; ")}; time=${formatSeconds(run.durationMs)}, input=${run.inputTokens}, improvement=${formatPercent(run.improvement)}`,
            )
            .join("\n")
        : "- none",
      "",
    ]
      .filter((line) => line !== undefined)
      .join("\n"),
  );
  return { jsonPath, markdownPath, report };
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const sessionDirs = args.paths.length
    ? args.paths.map(resolveSessionDir)
    : await discoverSessionDirs();
  if (!sessionDirs.length) {
    throw new Error(
      "No sessions found. Pass a session id or session directory.",
    );
  }
  const results = [];
  for (const sessionDir of sessionDirs) {
    results.push(await analyzeSession(sessionDir, args.outputDir));
  }
  console.log(
    results
      .map(
        (result) =>
          `${result.report.session.id}: ${result.markdownPath} (${formatPercent(result.report.final.diffRatio)})`,
      )
      .join("\n"),
  );
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
