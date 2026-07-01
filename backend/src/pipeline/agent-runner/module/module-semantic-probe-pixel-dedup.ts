import type { Box } from "../../../core/geometry.js";
import {
  readPngRgbaImage,
  type PngRgbaImage,
} from "./module-semantic-png.js";
import type { SemanticProbeNode } from "./module-semantic-probes.js";

type PixelProbeArtifact = {
  node: SemanticProbeNode;
  outputPath: string;
};

type PixelDedupMetrics = {
  heightDiff: number;
  heightDiffRatio: number;
  meanAlphaDiff255: number;
  meanDiff255: number;
  meanLuminanceDiff255: number;
  significantDiffRatio: number;
  visibleDiffRatio: number;
  widthDiff: number;
  widthDiffRatio: number;
};

type PixelDedupGroup = {
  duplicateIds: string[];
  representativeId: string;
};

type PixelDedupResult<TArtifact extends PixelProbeArtifact> = {
  deduplicatedArtifacts: TArtifact[];
  duplicateGroups: PixelDedupGroup[];
  duplicateToRepresentative: Map<string, string>;
};

type CroppedImage = {
  bounds: Box | null;
  data: Uint8Array;
  height: number;
  visiblePixelCount: number;
  width: number;
};

const ALPHA_VISIBLE_THRESHOLD = 1;
const COMPARE_SIZE = 96;
const CROP_DIMENSION_ABS_TOLERANCE = 2;
const CROP_DIMENSION_REL_TOLERANCE = 0.01;
const MEAN_DIFF_255_THRESHOLD = 1;
const SIGNIFICANT_DIFF_RATIO_THRESHOLD = 0.005;
const SIGNIFICANT_PIXEL_DIFF_THRESHOLD = 8 / 255;
const VISIBLE_PIXEL_DIFF_RATIO_THRESHOLD = 0.005;
const BBOX_DIMENSION_ABS_TOLERANCE = 1;
const BBOX_DIMENSION_REL_TOLERANCE = 0.005;
const PATH_DATA_LENGTH_REL_TOLERANCE = 0.02;

const normalizeAttr = (value: string | undefined) =>
  value?.trim().toLowerCase() ?? "";

const readNumberAttr = (value: string | undefined) => {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const relativeDifference = (left: number, right: number) =>
  Math.abs(left - right) / Math.max(Math.abs(left), Math.abs(right), 1);

const areDimensionsClose = ({
  absTolerance,
  left,
  relTolerance,
  right,
}: {
  absTolerance: number;
  left: number;
  relTolerance: number;
  right: number;
}) =>
  Math.abs(left - right) <= absTolerance ||
  relativeDifference(left, right) <= relTolerance;

const getPaintKey = (node: SemanticProbeNode) => {
  const attrs = node.attrs;
  return [
    node.tag,
    normalizeAttr(attrs.fill),
    normalizeAttr(attrs.stroke),
    normalizeAttr(attrs.opacity),
    normalizeAttr(attrs["fill-opacity"]),
    normalizeAttr(attrs["stroke-opacity"]),
    normalizeAttr(attrs["stroke-width"]),
    normalizeAttr(attrs["fill-rule"]),
  ].join("|");
};

const areBboxesClose = (left: Box, right: Box) =>
  areDimensionsClose({
    absTolerance: BBOX_DIMENSION_ABS_TOLERANCE,
    left: left.width,
    relTolerance: BBOX_DIMENSION_REL_TOLERANCE,
    right: right.width,
  }) &&
  areDimensionsClose({
    absTolerance: BBOX_DIMENSION_ABS_TOLERANCE,
    left: left.height,
    relTolerance: BBOX_DIMENSION_REL_TOLERANCE,
    right: right.height,
  });

const arePathLengthsClose = (
  left: SemanticProbeNode,
  right: SemanticProbeNode,
) => {
  if (left.tag !== "path" || right.tag !== "path") return true;
  const leftLength = readNumberAttr(left.attrs.pathDataLength);
  const rightLength = readNumberAttr(right.attrs.pathDataLength);
  if (!leftLength || !rightLength) return true;
  return relativeDifference(leftLength, rightLength) <= PATH_DATA_LENGTH_REL_TOLERANCE;
};

const areMetadataCompatible = (
  left: PixelProbeArtifact,
  right: PixelProbeArtifact,
) =>
  getPaintKey(left.node) === getPaintKey(right.node) &&
  areBboxesClose(left.node.bbox, right.node.bbox) &&
  arePathLengthsClose(left.node, right.node);

const cropVisibleAlpha = (image: PngRgbaImage): CroppedImage => {
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;
  let visiblePixelCount = 0;

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const alpha = image.data[(y * image.width + x) * 4 + 3] ?? 0;
      if (alpha <= ALPHA_VISIBLE_THRESHOLD) continue;
      visiblePixelCount += 1;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }

  if (right < left || bottom < top) {
    return {
      bounds: null,
      data: new Uint8Array(),
      height: 0,
      visiblePixelCount,
      width: 0,
    };
  }

  const width = right - left + 1;
  const height = bottom - top + 1;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceOffset = ((top + y) * image.width + left + x) * 4;
      const targetOffset = (y * width + x) * 4;
      data[targetOffset] = image.data[sourceOffset] ?? 0;
      data[targetOffset + 1] = image.data[sourceOffset + 1] ?? 0;
      data[targetOffset + 2] = image.data[sourceOffset + 2] ?? 0;
      data[targetOffset + 3] = image.data[sourceOffset + 3] ?? 0;
    }
  }

  return {
    bounds: {
      height,
      width,
      x: left,
      y: top,
    },
    data,
    height,
    visiblePixelCount,
    width,
  };
};

const sampleComparisonPixels = (image: CroppedImage) => {
  const sampled = new Float32Array(COMPARE_SIZE * COMPARE_SIZE * 2);
  if (image.width === 0 || image.height === 0) return sampled;

  for (let y = 0; y < COMPARE_SIZE; y += 1) {
    const sourceY = Math.min(
      image.height - 1,
      Math.max(
        0,
        Math.round(((y + 0.5) * image.height) / COMPARE_SIZE - 0.5),
      ),
    );
    for (let x = 0; x < COMPARE_SIZE; x += 1) {
      const sourceX = Math.min(
        image.width - 1,
        Math.max(
          0,
          Math.round(((x + 0.5) * image.width) / COMPARE_SIZE - 0.5),
        ),
      );
      const sourceOffset = (sourceY * image.width + sourceX) * 4;
      const alpha = (image.data[sourceOffset + 3] ?? 0) / 255;
      const red = image.data[sourceOffset] ?? 0;
      const green = image.data[sourceOffset + 1] ?? red;
      const blue = image.data[sourceOffset + 2] ?? red;
      const luminance = (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
      const targetOffset = (y * COMPARE_SIZE + x) * 2;
      sampled[targetOffset] = alpha;
      sampled[targetOffset + 1] = luminance * alpha;
    }
  }

  return sampled;
};

const compareCroppedImages = (
  left: CroppedImage,
  right: CroppedImage,
): PixelDedupMetrics => {
  const widthDiff = Math.abs(left.width - right.width);
  const heightDiff = Math.abs(left.height - right.height);
  const widthDiffRatio = widthDiff / Math.max(left.width, right.width, 1);
  const heightDiffRatio = heightDiff / Math.max(left.height, right.height, 1);
  const visibleDiffRatio =
    Math.abs(left.visiblePixelCount - right.visiblePixelCount) /
    Math.max(left.visiblePixelCount, right.visiblePixelCount, 1);
  const leftPixels = sampleComparisonPixels(left);
  const rightPixels = sampleComparisonPixels(right);

  let alphaTotal = 0;
  let luminanceTotal = 0;
  let total = 0;
  let significant = 0;
  const pixelCount = COMPARE_SIZE * COMPARE_SIZE;
  for (let index = 0; index < leftPixels.length; index += 2) {
    const alphaDiff = Math.abs((leftPixels[index] ?? 0) - (rightPixels[index] ?? 0));
    const luminanceDiff = Math.abs(
      (leftPixels[index + 1] ?? 0) - (rightPixels[index + 1] ?? 0),
    );
    const diff = Math.max(alphaDiff, luminanceDiff);
    alphaTotal += alphaDiff;
    luminanceTotal += luminanceDiff;
    total += diff;
    if (diff > SIGNIFICANT_PIXEL_DIFF_THRESHOLD) significant += 1;
  }

  return {
    heightDiff,
    heightDiffRatio,
    meanAlphaDiff255: (alphaTotal / pixelCount) * 255,
    meanDiff255: (total / pixelCount) * 255,
    meanLuminanceDiff255: (luminanceTotal / pixelCount) * 255,
    significantDiffRatio: significant / pixelCount,
    visibleDiffRatio,
    widthDiff,
    widthDiffRatio,
  };
};

const isPixelDuplicate = (metrics: PixelDedupMetrics) =>
  areCropDimensionsClose(metrics) &&
  metrics.meanDiff255 <= MEAN_DIFF_255_THRESHOLD &&
  metrics.significantDiffRatio <= SIGNIFICANT_DIFF_RATIO_THRESHOLD &&
  metrics.visibleDiffRatio <= VISIBLE_PIXEL_DIFF_RATIO_THRESHOLD;

const areCropDimensionsClose = (metrics: PixelDedupMetrics) =>
  (metrics.widthDiff <= CROP_DIMENSION_ABS_TOLERANCE ||
    metrics.widthDiffRatio <= CROP_DIMENSION_REL_TOLERANCE) &&
  (metrics.heightDiff <= CROP_DIMENSION_ABS_TOLERANCE ||
    metrics.heightDiffRatio <= CROP_DIMENSION_REL_TOLERANCE);

const deduplicateProbeArtifactsByPixels = async <
  TArtifact extends PixelProbeArtifact,
>(
  artifacts: TArtifact[],
): Promise<PixelDedupResult<TArtifact>> => {
  if (artifacts.length <= 1) {
    return {
      deduplicatedArtifacts: artifacts,
      duplicateGroups: [],
      duplicateToRepresentative: new Map(),
    };
  }

  const imageCache = new Map<string, CroppedImage | null>();
  const readCroppedImage = async (artifact: TArtifact) => {
    const cached = imageCache.get(artifact.node.id);
    if (cached !== undefined) return cached;
    const image = await readPngRgbaImage(artifact.outputPath);
    const cropped = image ? cropVisibleAlpha(image) : null;
    imageCache.set(artifact.node.id, cropped);
    return cropped;
  };

  const representativeByKey = new Map<string, TArtifact[]>();
  const deduplicatedArtifacts: TArtifact[] = [];
  const duplicateToRepresentative = new Map<string, string>();
  const duplicateGroupMap = new Map<string, string[]>();

  for (const artifact of artifacts) {
    const key = getPaintKey(artifact.node);
    const representatives = representativeByKey.get(key) ?? [];
    let matchedRepresentative: TArtifact | undefined;

    for (const representative of representatives) {
      if (!areMetadataCompatible(representative, artifact)) continue;
      const left = await readCroppedImage(representative);
      const right = await readCroppedImage(artifact);
      if (!left || !right) continue;
      const metrics = compareCroppedImages(left, right);
      if (!areCropDimensionsClose(metrics)) continue;
      if (isPixelDuplicate(metrics)) {
        matchedRepresentative = representative;
        break;
      }
    }

    if (matchedRepresentative) {
      const representativeId = matchedRepresentative.node.id;
      duplicateToRepresentative.set(artifact.node.id, representativeId);
      const group = duplicateGroupMap.get(representativeId) ?? [];
      group.push(artifact.node.id);
      duplicateGroupMap.set(representativeId, group);
      continue;
    }

    representatives.push(artifact);
    representativeByKey.set(key, representatives);
    deduplicatedArtifacts.push(artifact);
  }

  return {
    deduplicatedArtifacts,
    duplicateGroups: [...duplicateGroupMap.entries()].map(
      ([representativeId, duplicateIds]) => ({
        duplicateIds,
        representativeId,
      }),
    ),
    duplicateToRepresentative,
  };
};

export {
  compareCroppedImages,
  cropVisibleAlpha,
  deduplicateProbeArtifactsByPixels,
};
export type {
  PixelDedupGroup,
  PixelDedupMetrics,
  PixelDedupResult,
  PixelProbeArtifact,
};
