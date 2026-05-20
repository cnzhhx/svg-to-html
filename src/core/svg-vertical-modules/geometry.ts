import { areaOf } from "../geometry.js";
import type { Box, Region } from "../utils.js";
import type {
  ModuleBox,
  PlannerShellEntry,
  SerializableRegion,
} from "./types.js";

export const round = (value: number, digits = 3) =>
  Number(value.toFixed(digits));

export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export { areaOf };

export const isPageScaleBox = (box: Box, viewport: Box) => {
  const areaRatio = areaOf(box) / Math.max(1, areaOf(viewport));
  return (
    areaRatio >= 0.82 &&
    box.width >= viewport.width * 0.88 &&
    box.height >= viewport.height * 0.62
  );
};

export const centerOf = (box: Box) => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
});

export const isFiniteBox = (box: Box) =>
  Number.isFinite(box.x) &&
  Number.isFinite(box.y) &&
  Number.isFinite(box.width) &&
  Number.isFinite(box.height) &&
  box.width > 0 &&
  box.height > 0;

export const toModuleBox = (box: Box, viewport: Box): ModuleBox | null => {
  if (!isFiniteBox(box)) return null;

  const x = clamp(box.x, viewport.x, viewport.x + viewport.width);
  const y = clamp(box.y, viewport.y, viewport.y + viewport.height);
  const right = clamp(
    box.x + box.width,
    viewport.x,
    viewport.x + viewport.width,
  );
  const bottom = clamp(
    box.y + box.height,
    viewport.y,
    viewport.y + viewport.height,
  );
  const width = right - x;
  const height = bottom - y;

  if (width <= 0 || height <= 0) return null;
  return {
    bottom: round(bottom),
    height: round(height),
    right: round(right),
    width: round(width),
    x: round(x),
    y: round(y),
  };
};

export const toSerializableRegion = (
  id: string,
  box: Box,
): SerializableRegion => ({
  height: round(box.height),
  id,
  width: round(box.width),
  x: round(box.x),
  y: round(box.y),
});

export const expandRegion = ({
  id,
  padding,
  region,
  viewport,
}: {
  id: string;
  padding: number;
  region: Region;
  viewport: Box;
}): SerializableRegion => {
  const expanded = toModuleBox(
    {
      height: region.height + padding * 2,
      width: region.width + padding * 2,
      x: region.x - padding,
      y: region.y - padding,
    },
    viewport,
  );

  return toSerializableRegion(id, expanded ?? region);
};

export const unionBoxes = (boxes: Box[]): Box | null => {
  if (!boxes.length) return null;

  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));

  return {
    height: round(bottom - top),
    width: round(right - left),
    x: round(left),
    y: round(top),
  };
};

export const pointInside = (point: { x: number; y: number }, box: Box) =>
  point.x >= box.x &&
  point.x <= box.x + box.width &&
  point.y >= box.y &&
  point.y <= box.y + box.height;

export const uniqueStrings = (items: string[]) => [...new Set(items)].sort();

export const shellIdsForRegion = ({
  containerIds,
  region,
  shellManifest,
}: {
  containerIds: string[];
  region: Region;
  shellManifest: PlannerShellEntry[];
}) =>
  uniqueStrings(
    shellManifest
      .filter(
        (entry) =>
          containerIds.includes(entry.containerId) ||
          (entry.box ? pointInside(centerOf(entry.box), region) : false),
      )
      .map((entry) => entry.containerId),
  );
