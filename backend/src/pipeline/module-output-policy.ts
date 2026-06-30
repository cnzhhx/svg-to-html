import path from "node:path";

import { safeDecodeUri } from "../core/file-io.js";
import type { Region } from "../core/geometry.js";
import { isString, normalizePathForCompare } from "./module-merge/utils.js";

type ModuleOutputAllowedAsset = {
  assetId?: null | string;
  assetKind?: null | string;
  assetName?: null | string;
  assetPath?: null | string;
  assetRole?: null | string;
  assetType?: null | string;
  avifPath?: null | string;
  bitmapReason?: null | string;
  box?: Region;
  containsIntrinsicText?: boolean;
  containsText?: boolean;
  containerId?: string;
  htmlRef?: null | string;
  jpegPath?: null | string;
  jpgPath?: null | string;
  kind?: null | string;
  matchedTextBlockIds?: string[];
  mediaType?: null | string;
  mimeType?: null | string;
  name?: null | string;
  path?: null | string;
  pngPath?: null | string;
  overlapsReadableText?: boolean;
  relativePath?: null | string;
  source?: null | string;
  sourcePath?: null | string;
  svgPath?: null | string;
  textTreatment?: null | string;
  type?: null | string;
  url?: null | string;
  webpPath?: null | string;
  [key: string]: unknown;
};

const SUPPORTED_MODULE_ASSET_EXTENSIONS = [
  ".svg",
  ".png",
  ".webp",
  ".jpg",
  ".jpeg",
  ".avif",
] as const;

const MODULE_LOCAL_ASSET_DIR = "assets";

const stripQueryHash = (value: string) => value.split(/[?#]/, 1)[0] ?? value;

const stripFileUrl = (value: string) =>
  value.startsWith("file://") ? value.slice("file://".length) : value;

const normalizeSlashes = (value: string) => value.replaceAll("\\", "/");

const cleanReference = (value: string) =>
  stripFileUrl(stripQueryHash(safeDecodeUri(value.trim())));

const getReferenceExtension = (value: string) =>
  path.extname(cleanReference(value)).toLowerCase();

const isSupportedModuleAssetPath = (value: string) =>
  SUPPORTED_MODULE_ASSET_EXTENSIONS.includes(
    getReferenceExtension(
      value,
    ) as (typeof SUPPORTED_MODULE_ASSET_EXTENSIONS)[number],
  );

const getAllowedAssetPathValues = (asset: ModuleOutputAllowedAsset) =>
  [
    asset.svgPath,
    asset.pngPath,
    asset.webpPath,
    asset.jpgPath,
    asset.jpegPath,
    asset.avifPath,
    asset.assetPath,
    asset.path,
    asset.relativePath,
    asset.htmlRef,
    asset.sourcePath,
    asset.url,
  ].filter(isString);

const isPathInside = (candidate: string, parent: string) => {
  const normalizedCandidate = normalizePathForCompare(candidate);
  const normalizedParent = normalizePathForCompare(parent);
  return (
    normalizedCandidate === normalizedParent ||
    normalizedCandidate.startsWith(`${normalizedParent}/`)
  );
};

export type {
  ModuleOutputAllowedAsset,
};
export {
  MODULE_LOCAL_ASSET_DIR,
  getAllowedAssetPathValues,
  isPathInside,
  isSupportedModuleAssetPath,
  normalizeSlashes,
};
