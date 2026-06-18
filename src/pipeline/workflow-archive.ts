import path from "node:path";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import {
  WORKFLOW_ARCHIVE_FULL_EVERY_N,
  WORKFLOW_ARCHIVE_TEXT_MAX_CHARS,
} from "../config/index.js";
import { truncate } from "../core/string-utils.js";
import { writeJsonFile, writeTextFile } from "../core/file-io.js";

import type {
  WorkflowArchiveEntry,
  WorkflowArchiveItem,
  WorkflowArchiveStage,
} from "../session-store.js";

type WorkflowArchiveMaterial =
  | {
      kind: "file";
      label: string;
      optional?: boolean;
      sourcePath: string;
      targetName?: string;
    }
  | {
      kind: "json";
      label: string;
      payload: unknown;
      targetName: string;
    }
  | {
      kind: "text";
      label: string;
      content: string;
      targetName: string;
    };

type ArchiveWorkflowCheckpointOptions = {
  artifactDir: string;
  diffRatio?: number;
  materials: WorkflowArchiveMaterial[];
  metadata?: Record<string, unknown>;
  note?: string;
  round: number;
  stage: WorkflowArchiveStage;
};

type WorkflowArchiveManifest = {
  entries: WorkflowArchiveEntry[];
  updatedAt: number;
};

const HEAVY_ARCHIVE_FILE_LABELS = new Set([
  "Rendered SVG PNG",
  "Rendered Output PNG",
  "Diff PNG",
  "Render Entry Snapshot",
  "Rejected Render Entry Snapshot",
]);

const manifestWriteQueue = new Map<string, Promise<void>>();

const getWorkflowHistoryDir = (artifactDir: string) =>
  path.join(artifactDir, "workflow-history");

const getWorkflowHistoryManifestPath = (artifactDir: string) =>
  path.join(getWorkflowHistoryDir(artifactDir), "manifest.json");

const ensureFileExists = async (filePath: string) => {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
};

const readManifest = async (
  manifestPath: string,
): Promise<WorkflowArchiveManifest> => {
  try {
    return JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as WorkflowArchiveManifest;
  } catch {
    return { entries: [], updatedAt: Date.now() };
  }
};

const withManifestWriteLock = async <T>(
  manifestPath: string,
  write: () => Promise<T>,
) => {
  const previous = manifestWriteQueue.get(manifestPath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(
    () => current,
    () => current,
  );
  manifestWriteQueue.set(manifestPath, queued);

  await previous.catch(() => undefined);
  try {
    return await write();
  } finally {
    release();
    if (manifestWriteQueue.get(manifestPath) === queued) {
      manifestWriteQueue.delete(manifestPath);
    }
  }
};

const truncateArchiveText = (value: string) =>
  truncate(
    value,
    WORKFLOW_ARCHIVE_TEXT_MAX_CHARS,
    (v, m) => `\n[archive text truncated ${v.length - m} chars]`,
  );

const shouldWriteFullMaterials = ({
  round,
  stage,
}: {
  round: number;
  stage: WorkflowArchiveStage;
}) => {
  if (stage === "analysis" || stage === "agent") return true;
  if (round <= 1) return true;
  if (WORKFLOW_ARCHIVE_FULL_EVERY_N <= 0) return false;
  return round % WORKFLOW_ARCHIVE_FULL_EVERY_N === 0;
};

const filterArchiveMaterials = ({
  materials,
  round,
  stage,
}: {
  materials: WorkflowArchiveMaterial[];
  round: number;
  stage: WorkflowArchiveStage;
}) => {
  if (shouldWriteFullMaterials({ round, stage })) return materials;
  return materials.filter(
    (material) =>
      material.kind !== "file" ||
      !HEAVY_ARCHIVE_FILE_LABELS.has(material.label),
  );
};

const writeMaterial = async (
  checkpointDir: string,
  material: WorkflowArchiveMaterial,
): Promise<null | WorkflowArchiveItem> => {
  switch (material.kind) {
    case "file": {
      const exists = await ensureFileExists(material.sourcePath);
      if (!exists) {
        if (material.optional) return null;
        throw new Error(
          `Workflow archive source not found: ${material.sourcePath}`,
        );
      }

      const targetPath = path.join(
        checkpointDir,
        material.targetName ?? path.basename(material.sourcePath),
      );
      await mkdir(path.dirname(targetPath), { recursive: true });
      await copyFile(material.sourcePath, targetPath);
      return {
        kind: "file",
        label: material.label,
        path: targetPath,
        sourcePath: material.sourcePath,
      };
    }
    case "json": {
      const targetPath = path.join(checkpointDir, material.targetName);
      await writeJsonFile(targetPath, material.payload);
      return {
        kind: "json",
        label: material.label,
        path: targetPath,
      };
    }
    case "text": {
      const targetPath = path.join(checkpointDir, material.targetName);
      await writeTextFile(targetPath, truncateArchiveText(material.content));
      return {
        kind: "text",
        label: material.label,
        path: targetPath,
      };
    }
  }
};

const archiveWorkflowCheckpoint = async ({
  artifactDir,
  diffRatio,
  materials,
  metadata,
  note,
  round,
  stage,
}: ArchiveWorkflowCheckpointOptions): Promise<WorkflowArchiveEntry> => {
  const createdAt = Date.now();
  const checkpointId = `${createdAt}-${randomUUID()}`;
  const historyDir = getWorkflowHistoryDir(artifactDir);
  const historyManifestPath = getWorkflowHistoryManifestPath(artifactDir);
  const checkpointDir = path.join(
    historyDir,
    `round-${round}`,
    `${checkpointId}-${stage}`,
  );

  await mkdir(checkpointDir, { recursive: true });

  const effectiveMaterials = filterArchiveMaterials({
    materials,
    round,
    stage,
  });
  const items = (
    await Promise.all(
      effectiveMaterials.map((material) =>
        writeMaterial(checkpointDir, material),
      ),
    )
  ).filter((item): item is WorkflowArchiveItem => item !== null);

  const entry: WorkflowArchiveEntry = {
    id: `round-${round}-${stage}-${checkpointId}`,
    round,
    stage,
    dir: checkpointDir,
    historyDir,
    historyManifestPath,
    manifestPath: path.join(checkpointDir, "checkpoint.json"),
    createdAt,
    diffRatio,
    note,
    metadata,
    items,
  };

  await writeJsonFile(entry.manifestPath, entry);

  await withManifestWriteLock(historyManifestPath, async () => {
    const manifest = await readManifest(historyManifestPath);
    manifest.entries.push(entry);
    manifest.updatedAt = createdAt;
    await writeJsonFile(historyManifestPath, manifest);
  });

  return entry;
};

export {
  archiveWorkflowCheckpoint,
};
export type { WorkflowArchiveMaterial };
