import { pathToFileURL } from "node:url";

import { evaluatePage, launchEdge } from "./cdp.js";
import type { Box } from "./utils.js";

type TextStyleInferenceInputBlock = {
  color?: string;
  currentDeclarations?: Record<string, string>;
  id: string;
  lineHeight?: number;
  region: Box;
  renderScale?: number;
  styleMetricWeight?: number;
  text: string;
  visualRegion?: Box;
};

type TextStyleInferenceRecommendation = {
  declarations: Record<string, string>;
  fit: {
    heightDelta: number;
    score: number;
    visualDensityDelta?: number;
    visualIou?: number;
    widthDelta: number;
  };
  id: string;
  region: Box;
  text: string;
};

const fontFamilies = [
  `"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`,
  `Inter, "PingFang SC", "Microsoft YaHei", sans-serif`,
  `Arial, "PingFang SC", "Microsoft YaHei", sans-serif`,
];

const visualSimilarityProfile = {
  candidateAlphaThreshold: 0.1,
  channelMaxDistance: Math.hypot(255, 255, 255),
  colorErrorWeight: 100,
  densityWeight: 18,
  foregroundQuantile: 0.82,
  heightWeight: 6,
  iouWeight: 24,
  maskMinDistance: 10,
  maskThresholdScale: 0.65,
  maskThresholdQuantile: 0.75,
  maxAlignmentShiftPx: 2,
  widthWeight: 6,
};

const normalizeText = (value: string) => value.replace(/\s+/g, " ").trim();

const inferTextStyles = async ({
  blocks,
  targetImagePath,
}: {
  blocks: TextStyleInferenceInputBlock[];
  targetImagePath?: string;
}) => {
  const browser = await launchEdge();
  const htmlUrl = pathToFileURL(process.cwd()).href;
  const targetImageUrl = targetImagePath ? pathToFileURL(targetImagePath).href : undefined;

  try {
    return await evaluatePage<TextStyleInferenceRecommendation[]>({
      expression: `(async () => {
        const blocks = ${JSON.stringify(
          blocks.map((block) => ({
            ...block,
            currentDeclarations: block.currentDeclarations ?? {},
            text: normalizeText(block.text),
          })),
        )};
        const fontFamilies = ${JSON.stringify(fontFamilies)};
        const visualSimilarityProfile = ${JSON.stringify(visualSimilarityProfile)};
        const targetImageUrl = ${JSON.stringify(targetImageUrl)};
        const canvas = document.createElement('canvas');
        canvas.width = 2400;
        canvas.height = 800;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas 2D context unavailable');
        const targetImage = targetImageUrl
          ? await new Promise((resolve, reject) => {
              const image = new Image();
              image.onload = () => resolve(image);
              image.onerror = () => reject(new Error('Unable to load target image: ' + targetImageUrl));
              image.src = targetImageUrl;
            })
          : null;

        const parsePx = (value) => {
          const parsed = Number.parseFloat(String(value ?? ''));
          return Number.isFinite(parsed) ? parsed : null;
        };
        const toHex = (channel) => {
          const value = Math.max(0, Math.min(255, Math.round(channel)));
          return value.toString(16).padStart(2, '0').toUpperCase();
        };
        const rgbToHex = (rgb) => '#' + toHex(rgb[0]) + toHex(rgb[1]) + toHex(rgb[2]);
        const round = (value, digits = 3) => Number(value.toFixed(digits));
        const sizeRange = (height) => {
          const min = Math.max(8, Math.floor(height * 0.5));
          const max = Math.min(180, Math.ceil(height * 2.4 + 18));
          const values = [];
          for (let size = min; size <= max; size += 1) values.push(size);
          return values;
        };
        const maxAcceptedWidthOverflowRatio = 0.05;
        const spacingRange = () => [0];
        const getRenderScale = (block) =>
          typeof block.renderScale === 'number' && Number.isFinite(block.renderScale) && block.renderScale > 0
            ? block.renderScale
            : 1;
        const styleHeightTargets = blocks.map((block) => block.region.height / getRenderScale(block));
        const clusteredStyleHeight = (height) => {
          const peers = styleHeightTargets.filter((candidate) => Math.abs(candidate - height) <= 2);
          return peers.length >= 2 ? Math.max(...peers) : height;
        };
        const measure = ({ family, fontSize, fontWeight, letterSpacing, text }) => {
          ctx.font = fontWeight + ' ' + fontSize + 'px ' + family;
          ctx.textBaseline = 'alphabetic';
          const metrics = ctx.measureText(text);
          const left = Number(metrics.actualBoundingBoxLeft ?? 0);
          const right = Number(metrics.actualBoundingBoxRight ?? metrics.width ?? 0);
          const ascent = Number(metrics.actualBoundingBoxAscent ?? fontSize * 0.8);
          const descent = Number(metrics.actualBoundingBoxDescent ?? fontSize * 0.2);
          const glyphWidth = Math.max(0, left + right);
          const spacingWidth = Math.max(0, text.length - 1) * letterSpacing;
          return {
            height: Math.max(1, ascent + descent),
            width: Math.max(1, glyphWidth + spacingWidth),
          };
        };
        const cropTarget = (region) => {
          if (!targetImage) return null;
          const x = Math.max(0, Math.floor(region.x));
          const y = Math.max(0, Math.floor(region.y));
          const imageWidth = Number(targetImage.naturalWidth ?? targetImage.width ?? 0);
          const imageHeight = Number(targetImage.naturalHeight ?? targetImage.height ?? 0);
          const width = Math.max(
            1,
            Math.min(
              Math.ceil(region.width),
              imageWidth > x ? Math.floor(imageWidth - x) : Math.ceil(region.width),
            ),
          );
          const height = Math.max(
            1,
            Math.min(
              Math.ceil(region.height),
              imageHeight > y ? Math.floor(imageHeight - y) : Math.ceil(region.height),
            ),
          );
          const cropCanvas = document.createElement('canvas');
          cropCanvas.width = width;
          cropCanvas.height = height;
          const cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true });
          if (!cropCtx) return null;
          cropCtx.drawImage(targetImage, x, y, width, height, 0, 0, width, height);
          const data = cropCtx.getImageData(0, 0, width, height).data;
          const border = [];
          const sample = (index) => {
            border.push([data[index], data[index + 1], data[index + 2]]);
          };
          for (let px = 0; px < width; px += 1) {
            sample(px * 4);
            sample(((height - 1) * width + px) * 4);
          }
          for (let py = 1; py < height - 1; py += 1) {
            sample((py * width) * 4);
            sample((py * width + width - 1) * 4);
          }
          const median = (channel) => {
            const values = border.map((item) => item[channel]).sort((left, right) => left - right);
            return values[Math.floor(values.length / 2)] ?? 0;
          };
          const bg = [median(0), median(1), median(2)];
          const distances = [];
          for (let index = 0; index < data.length; index += 4) {
            const distance = Math.hypot(data[index] - bg[0], data[index + 1] - bg[1], data[index + 2] - bg[2]);
            distances.push(distance);
          }
          const sortedIndexes = distances
            .map((distance, index) => ({ distance, index }))
            .sort((left, right) => left.distance - right.distance);
          const thresholdBase =
            sortedIndexes[Math.floor(sortedIndexes.length * visualSimilarityProfile.maskThresholdQuantile)]?.distance ?? 0;
          const threshold = Math.max(
            visualSimilarityProfile.maskMinDistance,
            thresholdBase * visualSimilarityProfile.maskThresholdScale,
          );
          const mask = new Uint8Array(width * height);
          let ink = 0;
          for (let index = 0; index < distances.length; index += 1) {
            if (distances[index] >= threshold) {
              mask[index] = 1;
              ink += 1;
            }
          }
          const foregroundSamples = sortedIndexes.slice(
            Math.floor(sortedIndexes.length * visualSimilarityProfile.foregroundQuantile),
          );
          const foregroundMedian = (channel) => {
            const values = foregroundSamples
              .map((item) => data[item.index * 4 + channel])
              .sort((left, right) => left - right);
            return values[Math.floor(values.length / 2)] ?? bg[channel];
          };
          const fg = [foregroundMedian(0), foregroundMedian(1), foregroundMedian(2)];
          return { bg, data, fg, height, ink, mask, width };
        };
        const renderCandidate = ({ family, fontSize, fontWeight, height, letterSpacing, text, width }) => {
          const renderCanvas = document.createElement('canvas');
          renderCanvas.width = width;
          renderCanvas.height = height;
          const renderCtx = renderCanvas.getContext('2d', { willReadFrequently: true });
          if (!renderCtx) return null;
          renderCtx.clearRect(0, 0, width, height);
          renderCtx.fillStyle = '#000';
          renderCtx.font = fontWeight + ' ' + fontSize + 'px ' + family;
          renderCtx.textBaseline = 'alphabetic';
          const metrics = renderCtx.measureText(text);
          const left = Number(metrics.actualBoundingBoxLeft ?? 0);
          const right = Number(metrics.actualBoundingBoxRight ?? metrics.width ?? 0);
          const ascent = Number(metrics.actualBoundingBoxAscent ?? fontSize * 0.8);
          const descent = Number(metrics.actualBoundingBoxDescent ?? fontSize * 0.2);
          const measuredWidth = Math.max(1, left + right + Math.max(0, text.length - 1) * letterSpacing);
          const measuredHeight = Math.max(1, ascent + descent);
          const alphaFromImage = () => {
            const data = renderCtx.getImageData(0, 0, width, height).data;
            const alpha = new Float32Array(width * height);
            let ink = 0;
            for (let index = 0; index < alpha.length; index += 1) {
              const value = data[index * 4 + 3] / 255;
              alpha[index] = value;
              ink += value;
            }
            return { alpha, height: measuredHeight, ink, width: measuredWidth };
          };
          const drawText = (offsetX, offsetY) => {
            renderCtx.clearRect(0, 0, width, height);
            if (letterSpacing === 0) {
              renderCtx.fillText(text, offsetX - left, offsetY + ascent);
            } else {
              let cursor = offsetX - left;
              for (const char of text) {
                renderCtx.fillText(char, cursor, offsetY + ascent);
                cursor += renderCtx.measureText(char).width + letterSpacing;
              }
            }
            return alphaFromImage();
          };
          return { drawText, measuredHeight, measuredWidth };
        };
        const compareVisual = (targetCrop, candidateFactory) => {
          if (!targetCrop || !candidateFactory) return null;
          let best = null;
          const baseX = Math.round((targetCrop.width - candidateFactory.measuredWidth) / 2);
          const baseY = Math.round((targetCrop.height - candidateFactory.measuredHeight) / 2);
          for (
            let dy = -visualSimilarityProfile.maxAlignmentShiftPx;
            dy <= visualSimilarityProfile.maxAlignmentShiftPx;
            dy += 1
          ) {
            for (
              let dx = -visualSimilarityProfile.maxAlignmentShiftPx;
              dx <= visualSimilarityProfile.maxAlignmentShiftPx;
              dx += 1
            ) {
              const candidate = candidateFactory.drawText(baseX + dx, baseY + dy);
              let intersection = 0;
              let union = 0;
              let colorError = 0;
              for (let index = 0; index < targetCrop.mask.length; index += 1) {
                const targetOn = targetCrop.mask[index] === 1;
                const candidateOn = candidate.alpha[index] > visualSimilarityProfile.candidateAlphaThreshold;
                if (targetOn && candidateOn) intersection += 1;
                if (targetOn || candidateOn) union += 1;
                const alpha = candidate.alpha[index];
                const dataIndex = index * 4;
                const r = targetCrop.bg[0] + (targetCrop.fg[0] - targetCrop.bg[0]) * alpha;
                const g = targetCrop.bg[1] + (targetCrop.fg[1] - targetCrop.bg[1]) * alpha;
                const b = targetCrop.bg[2] + (targetCrop.fg[2] - targetCrop.bg[2]) * alpha;
                colorError += Math.hypot(
                  r - targetCrop.data[dataIndex],
                  g - targetCrop.data[dataIndex + 1],
                  b - targetCrop.data[dataIndex + 2],
                ) / visualSimilarityProfile.channelMaxDistance;
              }
              const iou = union ? intersection / union : 0;
              const densityDelta = Math.abs(candidate.ink - targetCrop.ink) / Math.max(1, targetCrop.ink);
              const widthDelta = Math.abs(candidateFactory.measuredWidth - targetCrop.width) / Math.max(1, targetCrop.width);
              const heightDelta = Math.abs(candidateFactory.measuredHeight - targetCrop.height) / Math.max(1, targetCrop.height);
              const score =
                (colorError / Math.max(1, targetCrop.mask.length)) * visualSimilarityProfile.colorErrorWeight +
                (1 - iou) * visualSimilarityProfile.iouWeight +
                densityDelta * visualSimilarityProfile.densityWeight +
                widthDelta * visualSimilarityProfile.widthWeight +
                heightDelta * visualSimilarityProfile.heightWeight;
              if (!best || score < best.score) {
                best = {
                  score,
                  visualDensityDelta: densityDelta,
                  visualIou: iou,
                };
              }
            }
          }
          return best;
        };

        return blocks.map((block) => {
          const target = block.visualRegion ?? block.region;
          const styleTarget = block.region;
          const renderScale =
            getRenderScale(block);
          const text = String(block.text ?? '').replace(/\\s+/g, ' ').trim();
          const currentSize = parsePx(block.currentDeclarations['font-size']);
          const currentWeight = block.currentDeclarations['font-weight'] ?? '';
          const currentFamily = block.currentDeclarations['font-family'] ?? '';
          const currentColor = block.currentDeclarations['color'] ?? block.color ?? '';
          const styleMetricWeight =
            typeof block.styleMetricWeight === 'number' && Number.isFinite(block.styleMetricWeight)
              ? Math.max(0, block.styleMetricWeight)
              : 0;
          const lineHeightTarget =
            typeof block.lineHeight === 'number' && Number.isFinite(block.lineHeight)
              ? block.lineHeight
              : null;
          const families = currentFamily
            ? [currentFamily, ...fontFamilies.filter((family) => family !== currentFamily)]
            : fontFamilies;
          const weights = ['400', '500', '600', '650', '700', '750', '800', '900', '950'];
          const targetCrop = cropTarget(target);
          const targetLikelyIncludesNonText =
            target.width > target.height * Math.max(1, text.length) * 1.35;
          const widthWeight = targetLikelyIncludesNonText ? 0.25 : 1.35;
          if (currentWeight && !weights.includes(String(currentWeight))) {
            weights.unshift(String(currentWeight));
          }
          const sizes = sizeRange(styleTarget.height / renderScale);
          if (currentSize && !sizes.includes(Math.round(currentSize))) {
            sizes.push(Math.round(currentSize));
            sizes.sort((left, right) => left - right);
          }

          const betterCandidate = (candidate, best) =>
            !best || candidate.fit.score < best.fit.score;
          const buildCandidate = ({ family, fontSize, fontWeight }) => {
            const renderFontSize = Math.max(1, fontSize * renderScale);
            const base = measure({
              family,
              fontSize: renderFontSize,
              fontWeight,
              letterSpacing: 0,
              text,
            });
            let bestForStyle = null;
            for (const letterSpacing of spacingRange(target.width, base.width, text.length)) {
              const measured = letterSpacing === 0
                ? base
                : measure({ family, fontSize: renderFontSize, fontWeight, letterSpacing, text });
              const widthDelta = measured.width - target.width;
              if (widthDelta > target.width * maxAcceptedWidthOverflowRatio) {
                continue;
              }
              const heightDelta = measured.height - target.height;
              const styleWidthDelta = measured.width - styleTarget.width;
              const styleHeightDelta = measured.height - styleTarget.height;
              const rawTargetCssHeight = styleTarget.height / renderScale;
              const targetCssHeight = clusteredStyleHeight(rawTargetCssHeight);
              const idealFontSize =
                targetCssHeight + (targetCssHeight <= 26 ? 2 : 1);
              const visualFontSizePrior =
                Math.abs(fontSize - targetCssHeight) * 5 +
                Math.max(0, fontSize - targetCssHeight) * 1.5;
              const familyIndex = Math.max(0, families.indexOf(family));
              const familyPrior = familyIndex * 2;
              const weightPrior =
                Math.abs(Number(fontWeight) - Number(neutralWeight)) / 100 * 0.2;
              const visual = compareVisual(
                targetCrop,
                renderCandidate({
                  family,
                  fontSize: renderFontSize,
                  fontWeight,
                  height: Math.max(1, Math.ceil(targetCrop?.height ?? target.height)),
                  letterSpacing,
                  text,
                  width: Math.max(1, Math.ceil(targetCrop?.width ?? target.width)),
                }),
              );
              const score = visual
                ? visual.score +
                  Math.abs(styleWidthDelta) * styleMetricWeight +
                  Math.abs(styleHeightDelta) * styleMetricWeight +
                  visualFontSizePrior +
                  familyPrior +
                  weightPrior +
                  Math.abs(letterSpacing) * 3
                : Math.abs(widthDelta) * widthWeight +
                  Math.abs(heightDelta) * 1.1 +
                  Math.abs(styleWidthDelta) * styleMetricWeight +
                  Math.abs(styleHeightDelta) * styleMetricWeight +
                  Math.abs(fontSize - idealFontSize) * 0.7 +
                  familyPrior +
                  weightPrior +
                  Math.abs(letterSpacing) * 3 +
                  Math.max(0, letterSpacing) * 1.2;
              const candidate = {
                declarations: {
                  ...(currentColor || targetCrop?.fg
                    ? { 'color': currentColor || rgbToHex(targetCrop.fg) }
                    : {}),
                  'font-family': family,
                  'font-size': fontSize + 'px',
                  'font-weight': String(fontWeight),
                  'letter-spacing': letterSpacing === 0 ? '0' : letterSpacing + 'px',
                  'line-height': Math.max(
                    fontSize,
                    Math.round(lineHeightTarget ?? targetCssHeight),
                  ) + 'px',
                },
                fit: {
                  heightDelta: round(heightDelta),
                  score: round(score),
                  visualDensityDelta: visual ? round(visual.visualDensityDelta) : undefined,
                  visualIou: visual ? round(visual.visualIou) : undefined,
                  widthDelta: round(widthDelta),
                },
              };
              if (betterCandidate(candidate, bestForStyle)) {
                bestForStyle = candidate;
              }
            }
            return bestForStyle;
          };

          const neutralWeight = currentWeight && weights.includes(String(currentWeight))
            ? String(currentWeight)
            : '400';
          let bestSize = null;
          for (const family of families) {
            for (const fontSize of sizes) {
              const candidate = buildCandidate({
                family,
                fontSize,
                fontWeight: neutralWeight,
              });
              if (candidate && betterCandidate(candidate, bestSize)) {
                bestSize = candidate;
              }
            }
          }

          const selectedFontSize =
            parsePx(bestSize?.declarations?.['font-size']) ?? currentSize ?? sizes[0];
          let best = null;
          for (const family of families) {
            for (const fontWeight of weights) {
              const candidate = buildCandidate({
                family,
                fontSize: selectedFontSize,
                fontWeight,
              });
              if (candidate && betterCandidate(candidate, best)) {
                best = candidate;
              }
            }
          }

          return {
            id: block.id,
            text,
            region: target,
            declarations: best.declarations,
            fit: best.fit,
          };
        });
      })()`,
      port: browser.port,
      readyExpression: "document.readyState === 'complete'",
      url: htmlUrl,
      viewportHeight: 800,
      viewportWidth: 1200,
    });
  } finally {
    await browser.close();
  }
};

export type {
  TextStyleInferenceInputBlock,
  TextStyleInferenceRecommendation,
};
export { inferTextStyles };
