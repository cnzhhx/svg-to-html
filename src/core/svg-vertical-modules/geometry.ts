import {
  areaOf,
  clamp,
  isFiniteBox,
  isPageScaleBox,
  pointInside,
  round,
  unionBoxes,
  uniqueStrings,
} from "../geometry.js";
import type { Box, Region } from "../utils.js";
import type {
  ModuleBox,
  SerializableRegion,
} from "./types.js";

export { areaOf, isFiniteBox, isPageScaleBox, pointInside, round, unionBoxes, uniqueStrings };

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
