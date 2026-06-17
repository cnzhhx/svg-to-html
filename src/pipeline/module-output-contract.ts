import type { Region } from "../core/utils.js";
import { normalizeAssetRole } from "../core/asset-role.js";

type ModuleOutputDiagnosticSeverity = "error" | "warning";

type ModuleOutputDiagnostic = {
  code: string;
  field?: string;
  file?: string;
  fixHint?: string;
  message: string;
  severity: ModuleOutputDiagnosticSeverity;
};

type GeneratedAssetManifestEntry = {
  assetRole: string;
  box: Region;
  containsText: boolean;
  path: string;
  source: "moduleGenerated";
  sourceNodeIndex?: number;
  sourceNodeTag?: string;
  textTreatment: string;
};


const GENERATED_ASSET_NO_ORDINARY_TEXT_TREATMENT =
  "no-ordinary-text";

const createGeneratedAssetManifestEntry = ({
  assetRole = "visual-asset",
  box,
  containsText = false,
  path,
  sourceNodeIndex,
  sourceNodeTag,
  textTreatment = GENERATED_ASSET_NO_ORDINARY_TEXT_TREATMENT,
}: {
  assetRole?: string;
  box: Region;
  containsText?: boolean;
  path: string;
  sourceNodeIndex?: number;
  sourceNodeTag?: string;
  textTreatment?: string;
}): GeneratedAssetManifestEntry => ({
  assetRole: normalizeAssetRole(assetRole) ?? "visual-asset",
  box,
  containsText,
  path,
  source: "moduleGenerated",
  ...(sourceNodeIndex !== undefined ? { sourceNodeIndex } : {}),
  ...(sourceNodeTag ? { sourceNodeTag } : {}),
  textTreatment,
});

export {
  GENERATED_ASSET_NO_ORDINARY_TEXT_TREATMENT,
  createGeneratedAssetManifestEntry,
};
export type {
  GeneratedAssetManifestEntry,
  ModuleOutputDiagnostic,
};
