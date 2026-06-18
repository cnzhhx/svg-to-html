import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { isRecord } from '../type-guards.js';
import { writeJsonFile } from "../file-io.js";
import {
  COMPONENT_LIBRARY_INSTALL_REGISTRY,
  COMPONENT_LIBRARY_INSTALL_TIMEOUT_MS,
} from "../../config/index.js";
import {
  enrichComponentLibraryDescriptor,
  validateComponentLibraryDescriptor,
} from "./descriptor.js";
import {
  getComponentLibrariesRoot,
  resolveComponentLibraryPaths,
} from "./paths.js";
import type {
  ComponentLibraryDescriptor,
  ComponentLibraryMeta,
  ComponentLibraryRegistryItem,
  ComponentLibrarySessionRef,
} from "./types.js";

type CommandResult = {
  stderr: string;
  stdout: string;
};

const execFileAsync = promisify(execFile);

const readJsonFile = async <T>(filePath: string): Promise<T> =>
  JSON.parse(await readFile(filePath, "utf8")) as T;

const readMetaIfExists = async (id: string): Promise<ComponentLibraryMeta | null> => {
  const { metaPath } = resolveComponentLibraryPaths(id);
  try {
    const parsed = await readJsonFile<unknown>(metaPath);
    return isRecord(parsed) ? (parsed as ComponentLibraryMeta) : null;
  } catch {
    return null;
  }
};

const writeMeta = async (id: string, meta: ComponentLibraryMeta) => {
  const { dir, metaPath } = resolveComponentLibraryPaths(id);
  await mkdir(dir, { recursive: true });
  await writeJsonFile(metaPath, meta);
};

const loadComponentLibraryDescriptor = async (
  id: string,
): Promise<ComponentLibraryDescriptor> => {
  const { descriptorPath, sourceDir } = resolveComponentLibraryPaths(id);
  const parsed = await readJsonFile<unknown>(descriptorPath);
  return enrichComponentLibraryDescriptor({
    descriptor: await validateComponentLibraryDescriptor({
      descriptor: parsed,
      expectedId: id,
      sourceDir,
    }),
    sourceDir,
  });
};

const writeComponentLibraryDescriptor = async ({
  descriptor,
  id,
}: {
  descriptor: ComponentLibraryDescriptor;
  id: string;
}) => {
  const { descriptorPath, dir } = resolveComponentLibraryPaths(id);
  await mkdir(dir, { recursive: true });
  await writeJsonFile(descriptorPath, descriptor);
};

const createComponentLibrarySessionRef = ({
  descriptor,
  id,
}: {
  descriptor: ComponentLibraryDescriptor;
  id: string;
}): ComponentLibrarySessionRef => {
  const { descriptorPath, sourceDir } = resolveComponentLibraryPaths(id);
  return {
    descriptorPath,
    framework: descriptor.framework,
    id,
    importPath: descriptor.package.importPath ?? descriptor.package.name,
    name: descriptor.name,
    packageName: descriptor.package.name,
    sourceDir,
  };
};

const componentLibraryToRegistryItem = async (
  id: string,
): Promise<ComponentLibraryRegistryItem | null> => {
  try {
    const descriptor = await loadComponentLibraryDescriptor(id);
    const meta = await readMetaIfExists(id);
    const { descriptorPath, sourceDir } = resolveComponentLibraryPaths(id);
    return {
      componentCount: descriptor.components.length,
      createdAt: meta?.createdAt,
      descriptorPath,
      framework: descriptor.framework,
      id,
      importPath: descriptor.package.importPath ?? descriptor.package.name,
      install: meta?.install,
      name: descriptor.name,
      packageName: descriptor.package.name,
      sourceDir,
      updatedAt: meta?.updatedAt,
    };
  } catch {
    return null;
  }
};

const listComponentLibraries = async (): Promise<ComponentLibraryRegistryItem[]> => {
  const root = getComponentLibrariesRoot();
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const libraries = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => componentLibraryToRegistryItem(entry.name)),
  );
  return libraries
    .filter((library): library is ComponentLibraryRegistryItem => Boolean(library))
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
};

const getComponentLibrary = async (id: string) => {
  const descriptor = await loadComponentLibraryDescriptor(id);
  const meta = await readMetaIfExists(id);
  return {
    descriptor,
    meta,
    registryItem: await componentLibraryToRegistryItem(id),
    sessionRef: createComponentLibrarySessionRef({ descriptor, id }),
  };
};

const deleteComponentLibrary = async (id: string) => {
  const { dir } = resolveComponentLibraryPaths(id);
  await rm(dir, { force: true, recursive: true });
};

const runCommand = async (
  command: string,
  args: string[],
  cwd: string,
  timeoutMs?: number,
): Promise<CommandResult> => {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
    });
    return {
      stderr: String(result.stderr ?? ""),
      stdout: String(result.stdout ?? ""),
    };
  } catch (error) {
    const failed = error as {
      code?: number | string;
      signal?: string | null;
      stderr?: string | Buffer;
      stdout?: string | Buffer;
    };
    const output = [failed.stdout, failed.stderr]
      .map((value) => String(value ?? ""))
      .join("\n")
      .trim()
      .slice(-4000);
    const timedOut = failed.signal === "SIGTERM";
    throw new Error(
      `${command} ${args.join(" ")} failed${timedOut ? ` (timed out after ${timeoutMs}ms)` : failed.code === undefined ? "" : ` with exit code ${failed.code}`}${output ? `\n${output}` : ""}`,
    );
  }
};

const ensureComponentLibraryDependenciesInstalled = async (id: string) => {
  const { sourceDir } = resolveComponentLibraryPaths(id);
  const meta =
    (await readMetaIfExists(id)) ??
    ({
      createdAt: Date.now(),
      id,
      sourceType: "local",
      updatedAt: Date.now(),
    } satisfies ComponentLibraryMeta);

  if (meta.install?.status === "completed") return meta.install;

  const packageJsonPath = path.join(sourceDir, "package.json");
  if (!existsSync(packageJsonPath)) {
    const install = {
      completedAt: Date.now(),
      skippedReason: "package.json not found",
      status: "skipped" as const,
    };
    await writeMeta(id, {
      ...meta,
      install,
      updatedAt: Date.now(),
    });
    return install;
  }

  try {
    const installArgs = ["install", "--no-frozen-lockfile"];
    // 注入 registry：默认走公开镜像，避免组件库 install 因公网拉包超时 hang 住。
    // 企业环境可在 env 置空字符串沿用 cwd 链上的 .npmrc / 全局配置。
    if (COMPONENT_LIBRARY_INSTALL_REGISTRY.trim()) {
      installArgs.push("--registry", COMPONENT_LIBRARY_INSTALL_REGISTRY.trim());
    }
    await runCommand(
      "pnpm",
      installArgs,
      sourceDir,
      COMPONENT_LIBRARY_INSTALL_TIMEOUT_MS,
    );
    const install = {
      completedAt: Date.now(),
      status: "completed" as const,
    };
    await writeMeta(id, {
      ...meta,
      install,
      updatedAt: Date.now(),
    });
    return install;
  } catch (error) {
    const install = {
      completedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
      status: "failed" as const,
    };
    await writeMeta(id, {
      ...meta,
      install,
      updatedAt: Date.now(),
    });
    throw error;
  }
};

const writeComponentLibraryMeta = writeMeta;

export {
  deleteComponentLibrary,
  ensureComponentLibraryDependenciesInstalled,
  getComponentLibrary,
  listComponentLibraries,
  loadComponentLibraryDescriptor,
  writeComponentLibraryDescriptor,
  writeComponentLibraryMeta,
};
