import path from "node:path";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const BEST_BACKUP_DIR_NAME = "agent-best-backup";
const BACKUP_MANIFEST_NAME = ".rollback-manifest.json";

type BackupManifest = {
  files: Array<{
    existed: boolean;
    relativePath: string;
  }>;
};

const getBestBackupDir = (artifactDir: string) =>
  path.join(artifactDir, BEST_BACKUP_DIR_NAME);

const getBackupManifestPath = (artifactDir: string) =>
  path.join(getBestBackupDir(artifactDir), BACKUP_MANIFEST_NAME);

const getRelativeBackupPath = (artifactDir: string, filePath: string) => {
  const relativePath = path.relative(artifactDir, filePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return path.join("_external", path.basename(filePath));
  }
  return relativePath;
};

const readBackupManifest = async (artifactDir: string): Promise<BackupManifest | undefined> => {
  try {
    const parsed = JSON.parse(await readFile(getBackupManifestPath(artifactDir), "utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as BackupManifest).files)
    ) {
      return parsed as BackupManifest;
    }
  } catch {}
  return undefined;
};

/**
 * 将指定文件备份到 artifactDir/agent-best-backup 目录，保留相对路径以避免并行模块文件名冲突。
 */
export async function backupBestFiles(
  artifactDir: string,
  filePaths: string[],
): Promise<void> {
  const backupDir = getBestBackupDir(artifactDir);
  await rm(backupDir, { force: true, recursive: true });
  await mkdir(backupDir, { recursive: true });
  const manifest: BackupManifest = { files: [] };

  for (const filePath of filePaths) {
    const relativePath = getRelativeBackupPath(artifactDir, filePath);
    const existed = existsSync(filePath);
    manifest.files.push({ existed, relativePath });
    if (!existed) continue;
    const targetPath = path.join(backupDir, relativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(filePath, targetPath);
  }

  await writeFile(getBackupManifestPath(artifactDir), JSON.stringify(manifest, null, 2), "utf8");
}

/**
 * 从最佳备份目录恢复文件。
 */
export async function restoreBestFiles(
  artifactDir: string,
  filePaths: string[],
): Promise<void> {
  const backupDir = getBestBackupDir(artifactDir);
  const manifest = await readBackupManifest(artifactDir);
  const existedByRelativePath = new Map(
    manifest?.files.map((item) => [item.relativePath, item.existed]) ?? [],
  );

  for (const filePath of filePaths) {
    const relativePath = getRelativeBackupPath(artifactDir, filePath);
    const existed = existedByRelativePath.get(relativePath);
    const sourcePath = path.join(backupDir, relativePath);
    if (existed === false) {
      await rm(filePath, { force: true });
      continue;
    }
    if (existsSync(sourcePath)) {
      await mkdir(path.dirname(filePath), { recursive: true });
      await copyFile(sourcePath, filePath);
    }
  }
}
