import path from "node:path";
import { writeFile, mkdir, stat, rename, rm } from "node:fs/promises";

const writeTextFile = async (filePath: string, content: string) => {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random()
      .toString(16)
      .slice(2)}.tmp`,
  );
  try {
    await writeFile(tmpPath, content, "utf8");
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
  return filePath;
};

const writeJsonFile = async (filePath: string, payload: unknown) => {
  await writeTextFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
};

const assertFile = async (filePath: string, label: string) => {
  try {
    await stat(filePath);
  } catch {
    throw new Error(`${label} not found: ${filePath}`);
  }
};

const safeDecodeUri = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export { assertFile, safeDecodeUri, writeJsonFile, writeTextFile };
