import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";

type PngAlphaStats = {
  averageLuminance?: number;
  hasAlpha: boolean;
  visiblePixelCount: number;
};

type PngRgbaImage = {
  data: Uint8Array;
  hasAlpha: boolean;
  height: number;
  width: number;
};

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const PROBE_ALPHA_VISIBLE_THRESHOLD = 10;

const getPngChannelCount = (colorType: number) => {
  switch (colorType) {
    case 0:
    case 3:
      return 1;
    case 2:
      return 3;
    case 4:
      return 2;
    case 6:
      return 4;
    default:
      return undefined;
  }
};

const paethPredictor = (left: number, up: number, upLeft: number) => {
  const estimate = left + up - upLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceUp = Math.abs(estimate - up);
  const distanceUpLeft = Math.abs(estimate - upLeft);
  if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) return left;
  if (distanceUp <= distanceUpLeft) return up;
  return upLeft;
};

const readPngRgbaImage = async (
  filePath: string,
): Promise<PngRgbaImage | null> => {
  const buffer = await readFile(filePath);
  if (
    buffer.length < PNG_SIGNATURE.length ||
    !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    return null;
  }

  let bitDepth = 0;
  let colorType = -1;
  let height = 0;
  let interlace = 0;
  let offset = PNG_SIGNATURE.length;
  let width = 0;
  const idatChunks: Buffer[] = [];

  while (offset + 12 <= buffer.length) {
    const chunkLength = buffer.readUInt32BE(offset);
    const chunkType = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    if (dataEnd + 4 > buffer.length) return null;

    if (chunkType === "IHDR") {
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      bitDepth = buffer[dataStart + 8] ?? 0;
      colorType = buffer[dataStart + 9] ?? -1;
      interlace = buffer[dataStart + 12] ?? 0;
    } else if (chunkType === "IDAT") {
      idatChunks.push(buffer.subarray(dataStart, dataEnd));
    } else if (chunkType === "IEND") {
      break;
    }

    offset = dataEnd + 4;
  }

  const channelCount = getPngChannelCount(colorType);
  if (
    !channelCount ||
    bitDepth !== 8 ||
    height <= 0 ||
    idatChunks.length === 0 ||
    interlace !== 0 ||
    width <= 0
  ) {
    return null;
  }

  const hasAlpha = colorType === 4 || colorType === 6;

  const inflated = inflateSync(Buffer.concat(idatChunks));
  const rowLength = width * channelCount;
  const previous = new Uint8Array(rowLength);
  const current = new Uint8Array(rowLength);
  const rgba = new Uint8Array(width * height * 4);
  let sourceOffset = 0;
  const alphaChannelOffset = colorType === 6 ? 3 : 1;

  for (let y = 0; y < height; y += 1) {
    if (sourceOffset >= inflated.length) return null;
    const filterType = inflated[sourceOffset] ?? -1;
    sourceOffset += 1;
    if (sourceOffset + rowLength > inflated.length) return null;

    for (let x = 0; x < rowLength; x += 1) {
      const raw = inflated[sourceOffset + x] ?? 0;
      const left = x >= channelCount ? (current[x - channelCount] ?? 0) : 0;
      const up = previous[x] ?? 0;
      const upLeft =
        x >= channelCount ? (previous[x - channelCount] ?? 0) : 0;
      let value: number;
      switch (filterType) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw + left;
          break;
        case 2:
          value = raw + up;
          break;
        case 3:
          value = raw + Math.floor((left + up) / 2);
          break;
        case 4:
          value = raw + paethPredictor(left, up, upLeft);
          break;
        default:
          return null;
      }
      current[x] = value & 0xff;
    }

    sourceOffset += rowLength;

    for (let x = 0; x < width; x += 1) {
      const pixelOffset = x * channelCount;
      const targetOffset = (y * width + x) * 4;
      const red = current[pixelOffset] ?? 0;
      const green = colorType === 2 || colorType === 6
        ? current[pixelOffset + 1] ?? red
        : red;
      const blue = colorType === 2 || colorType === 6
        ? current[pixelOffset + 2] ?? red
        : red;
      const alpha = hasAlpha
        ? current[pixelOffset + alphaChannelOffset] ?? 0
        : 255;
      rgba[targetOffset] = red;
      rgba[targetOffset + 1] = green;
      rgba[targetOffset + 2] = blue;
      rgba[targetOffset + 3] = alpha;
    }

    previous.set(current);
    current.fill(0);
  }

  return {
    data: rgba,
    hasAlpha,
    height,
    width,
  };
};

const readPngAlphaStats = async (
  filePath: string,
): Promise<PngAlphaStats | null> => {
  const image = await readPngRgbaImage(filePath);
  if (!image) return null;
  if (!image.hasAlpha) {
    return { hasAlpha: false, visiblePixelCount: image.width * image.height };
  }

  let luminanceSum = 0;
  let visiblePixelCount = 0;
  for (let pixelOffset = 0; pixelOffset < image.data.length; pixelOffset += 4) {
    const alpha = image.data[pixelOffset + 3] ?? 0;
    if (alpha <= PROBE_ALPHA_VISIBLE_THRESHOLD) continue;
    const red = image.data[pixelOffset] ?? 0;
    const green = image.data[pixelOffset + 1] ?? red;
    const blue = image.data[pixelOffset + 2] ?? red;
    luminanceSum += (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
    visiblePixelCount += 1;
  }

  return {
    averageLuminance:
      visiblePixelCount > 0 ? luminanceSum / visiblePixelCount : undefined,
    hasAlpha: true,
    visiblePixelCount,
  };
};

export { readPngAlphaStats, readPngRgbaImage };
export type { PngAlphaStats, PngRgbaImage };
