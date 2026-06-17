type CanonicalAssetRole =
  | "atomic-svg-node-visual-text-asset"
  | "background-underlay"
  | "icon-or-illustration"
  | "layout-shell"
  | "photo-or-bitmap"
  | "visual-asset";

const normalizeAssetRole = (
  value: unknown,
): CanonicalAssetRole | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;

  if (
    /\b(?:atomic-svg-node-visual-text-asset|atomic-visual-text|visual-text|single-node-visual-text|text-with-background|icon-text|logo-text|stylized-text|artistic-text)\b/i.test(
      normalized,
    )
  ) {
    return "atomic-svg-node-visual-text-asset";
  }
  if (
    /\b(?:layout-shell|page|full-page|whole-page|shell|fallback|original-svg|page-crop|svg-crop)\b/i.test(
      normalized,
    )
  ) {
    return "layout-shell";
  }
  if (
    /\b(?:background-underlay|background|underlay|backdrop|pattern|texture)\b/i.test(
      normalized,
    )
  ) {
    return "background-underlay";
  }
  if (
    /\b(?:photo-or-bitmap|photo|bitmap|raster|image|source-svg-embedded-raster)\b/i.test(
      normalized,
    )
  ) {
    return "photo-or-bitmap";
  }
  if (
    /\b(?:icon-or-illustration|icon|illustration|logo|avatar|thumbnail|cover)\b/i.test(
      normalized,
    )
  ) {
    return "icon-or-illustration";
  }
  if (
    /\b(?:visual-asset|decoration|ornament|badge|sticker|accent|module-generated|exported-svg-node|svg-node-asset)\b/i.test(
      normalized,
    )
  ) {
    return "visual-asset";
  }
  return undefined;
};

const hasConcreteVisualAssetRole = (
  role: CanonicalAssetRole | undefined,
) => role !== undefined && role !== "layout-shell";

export { hasConcreteVisualAssetRole, normalizeAssetRole };
export type { CanonicalAssetRole };
