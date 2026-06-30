import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { isRecord, parseJsonFile } from "./utils.js";
import type { ModuleFragmentManifest } from "./types.js";

const isSupportedAssetFile = (fileName: string) =>
  /\.(png|svg|jpg|jpeg|webp|avif|gif)$/i.test(fileName);

const scanAssetsDirectory = async (
  assetsDir: string,
  relativeDir = "",
): Promise<string[]> => {
  try {
    const absoluteDir = path.join(assetsDir, relativeDir);
    const entries = await readdir(absoluteDir, { withFileTypes: true });
    const refs = await Promise.all(
      entries.map(async (entry) => {
        const relativePath = path.join(relativeDir, entry.name);
        if (entry.isDirectory()) {
          return scanAssetsDirectory(assetsDir, relativePath);
        }
        if (!entry.isFile() || !isSupportedAssetFile(entry.name)) return [];
        return [path.posix.join("assets", relativePath.split(path.sep).join("/"))];
      }),
    );
    return refs.flat().sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
};

// Read a path-like reference from either a manifest asset object or legacy string.
const readAssetRef = (item: unknown): string | null => {
  if (typeof item === "string") return item;
  if (!isRecord(item)) return null;
  if (typeof item.path === "string") return item.path;
  if (typeof item.relativePath === "string") return item.relativePath;
  if (typeof item.htmlRef === "string") return item.htmlRef;
  return null;
};

// Normalize legacy asset records while keeping any metadata the agent supplied.
const normalizeAssetRecord = (
  item: unknown,
  ref: string,
): Record<string, unknown> => {
  if (typeof item === "string") {
    return { path: item, relativePath: item, htmlRef: item };
  }
  if (!isRecord(item)) {
    return { path: ref, relativePath: ref, htmlRef: ref };
  }
  return {
    ...item,
    path: typeof item.path === "string" ? item.path : ref,
    relativePath:
      typeof item.relativePath === "string" ? item.relativePath : ref,
    htmlRef: typeof item.htmlRef === "string" ? item.htmlRef : ref,
  };
};

const readRegisteredGeneratedAssets = async (
  moduleDir: string,
): Promise<Array<Record<string, unknown> & { path: string; relativePath: string; htmlRef: string }>> => {
  try {
    const semanticPath = path.join(moduleDir, "module-semantic.json");
    const document = await parseJsonFile<unknown>(semanticPath, "module semantic");
    if (!isRecord(document) || !Array.isArray(document.generatedAssets)) {
      return [];
    }

    return document.generatedAssets.flatMap((entry: unknown) => {
      if (!isRecord(entry)) return [];
      const ref =
        typeof entry.path === "string"
          ? entry.path
          : typeof entry.relativePath === "string"
            ? entry.relativePath
            : typeof entry.htmlRef === "string"
              ? entry.htmlRef
              : null;
      if (!ref) return [];
      return [
        {
          ...entry,
          path: ref,
          relativePath:
            typeof entry.relativePath === "string" ? entry.relativePath : ref,
          htmlRef: typeof entry.htmlRef === "string" ? entry.htmlRef : ref,
        },
      ];
    });
  } catch {
    return [];
  }
};

type FinalizeModuleManifestInput = {
  moduleDir: string;
};

/**
 * After a module agent finishes, normalize every local asset source into
 * manifest.producedAssets so the merge pipeline can carry assets forward.
 */
export const finalizeModuleManifest = async ({
  moduleDir,
}: FinalizeModuleManifestInput) => {
  const manifestPath = path.join(moduleDir, "manifest.json");

  let manifest: ModuleFragmentManifest;
  try {
    const raw = await readFile(manifestPath, "utf8");
    manifest = JSON.parse(raw) as ModuleFragmentManifest;
  } catch {
    manifest = {};
  }

  if (!isRecord(manifest)) {
    manifest = {};
  }

  // 收集资产来源：1) agent 注册到 semantic.json 的资产  2) assets/ 目录实际文件  3) manifest 中各种字段名残留的资产声明
  const assetsDir = path.join(moduleDir, "assets");
  const scannedAssets = await scanAssetsDirectory(assetsDir);
  const registeredAssets = await readRegisteredGeneratedAssets(moduleDir);

  // Merge by path. Registered semantic assets are authoritative because they
  // carry rendered boxes and source-node metadata.
  const producedAssetsMap = new Map<
    string,
    Record<string, unknown>
  >();

  const legacyManifestCollections = [
    manifest.producedAssets,
    (manifest as Record<string, unknown>).generatedAssets,
    (manifest as Record<string, unknown>).localAssets,
    (manifest as Record<string, unknown>).moduleAssets,
    (manifest as Record<string, unknown>).assets,
  ];
  for (const collection of legacyManifestCollections) {
    if (!Array.isArray(collection)) continue;
    for (const item of collection) {
      const ref = readAssetRef(item);
      if (!ref) continue;
      if (!producedAssetsMap.has(ref)) {
        producedAssetsMap.set(ref, normalizeAssetRecord(item, ref));
      }
    }
  }

  for (const ref of scannedAssets) {
    if (!producedAssetsMap.has(ref)) {
      producedAssetsMap.set(ref, { path: ref, relativePath: ref, htmlRef: ref });
    }
  }

  for (const asset of registeredAssets) {
    const ref = asset.path;
    const base = producedAssetsMap.get(ref) ?? {};
    producedAssetsMap.set(ref, {
      ...base,
      ...asset,
    });
  }

  delete (manifest as Record<string, unknown>).assets;
  delete (manifest as Record<string, unknown>).generatedAssets;
  delete (manifest as Record<string, unknown>).localAssets;
  delete (manifest as Record<string, unknown>).moduleAssets;

  manifest.producedAssets = Array.from(producedAssetsMap.values());

  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
};
