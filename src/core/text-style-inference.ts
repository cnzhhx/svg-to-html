import { pathToFileURL } from "node:url";

import { evaluatePage, launchEdge } from "./cdp.js";
import type { Box } from "./utils.js";

type TextStyleInferenceInputBlock = {
  color?: string;
  currentDeclarations?: Record<string, string>;
  id: string;
  lineCount?: number;
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
  `"Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", sans-serif`,
  `Inter, "Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", sans-serif`,
  `Arial, "Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", sans-serif`,
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

const normalizeFontFamily = (value?: string) => {
  if (!value) return "";
  const families = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => !/pingfang|hiragino/i.test(item))
    .filter((item) => item.length > 0);
  const hasConcreteFamily = families.some(
    (item) => !/^(serif|sans-serif|monospace|cursive|fantasy|system-ui)$/i.test(item),
  );
  return hasConcreteFamily ? families.join(", ") : "";
};

const inferTextStyles = async ({
  blocks,
  deviceScaleFactor = 1,
  targetImagePath,
}: {
  blocks: TextStyleInferenceInputBlock[];
  deviceScaleFactor?: number;
  targetImagePath?: string;
}) => {
  const browser = await launchEdge();
  const htmlUrl = pathToFileURL(process.cwd()).href;
  const targetImageUrl = targetImagePath ? pathToFileURL(targetImagePath).href : undefined;

  try {
    return await evaluatePage<TextStyleInferenceRecommendation[]>({
      deviceScaleFactor,
      expression: `(async () => {
        const blocks = ${JSON.stringify(
          blocks.map((block) => ({
            ...block,
            currentDeclarations: {
              ...(block.currentDeclarations ?? {}),
              'font-family': normalizeFontFamily(block.currentDeclarations?.['font-family']),
            },
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
        const clamp01 = (value) => Math.max(0, Math.min(1, value));
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
        const getRenderScale = (block) =>
          typeof block.renderScale === 'number' && Number.isFinite(block.renderScale) && block.renderScale > 0
            ? block.renderScale
            : 1;
        const styleHeightTargets = blocks.map((block) => block.region.height);
        const clusteredStyleHeight = (height) => {
          const peers = styleHeightTargets.filter((candidate) => Math.abs(candidate - height) <= 2);
          return peers.length >= 2 ? Math.max(...peers) : height;
        };
        const measure = ({ family, fontSize, fontWeight, text }) => {
          ctx.font = fontWeight + ' ' + fontSize + 'px ' + family;
          ctx.textBaseline = 'alphabetic';
          const metrics = ctx.measureText(text);
          const left = Number(metrics.actualBoundingBoxLeft ?? 0);
          const right = Number(metrics.actualBoundingBoxRight ?? metrics.width ?? 0);
          const ascent = Number(metrics.actualBoundingBoxAscent ?? fontSize * 0.8);
          const descent = Number(metrics.actualBoundingBoxDescent ?? fontSize * 0.2);
          return {
            height: Math.max(1, ascent + descent),
            width: Math.max(1, left + right),
          };
        };
        const wrapText = ({ family, fontSize, fontWeight, maxWidth, text }) => {
          ctx.font = fontWeight + ' ' + fontSize + 'px ' + family;
          const chars = Array.from(text);
          const lines = [];
          let line = '';
          for (const char of chars) {
            const nextLine = line + char;
            const nextWidth = ctx.measureText(nextLine).width;
            if (line && nextWidth > maxWidth) {
              lines.push(line);
              line = char.trimStart();
            } else {
              line = nextLine;
            }
          }
          if (line) lines.push(line);
          return lines.length ? lines : [text];
        };
        const measureLines = ({ family, fontSize, fontWeight, lineHeight, lines }) => {
          const measures = lines.map((line) =>
            measure({ family, fontSize, fontWeight, text: line }),
          );
          const maxHeight = Math.max(1, ...measures.map((item) => item.height));
          return {
            height: lines.length > 1
              ? Math.max(1, lineHeight * (lines.length - 1) + maxHeight)
              : maxHeight,
            lineHeight: maxHeight,
            width: Math.max(1, ...measures.map((item) => item.width)),
          };
        };
        const CJK_TEXT_RE = /[\\u3400-\\u9fff\\uf900-\\ufaff\\u3040-\\u30ff\\uac00-\\ud7af]/u;
        const COMPACT_METRIC_TEXT_RE = /^[\\s\\d.,:;+\\-\\u2212\\u00a5\\uffe5\\u0024\\u20ac\\u00a3\\u20a9%/()[\\]{}]+$/u;
        const COMPACT_METRIC_SIGNAL_RE = /[\\d\\u00a5\\uffe5\\u0024\\u20ac\\u00a3\\u20a9]/u;
        const usesCompactMetricSizing = (text) =>
          !CJK_TEXT_RE.test(text) &&
          COMPACT_METRIC_TEXT_RE.test(text) &&
          COMPACT_METRIC_SIGNAL_RE.test(text);
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
          const foregroundDistance =
            Math.hypot(fg[0] - bg[0], fg[1] - bg[1], fg[2] - bg[2]) /
            visualSimilarityProfile.channelMaxDistance;
          const coverage = ink / Math.max(1, width * height);
          const hasUsableSignal =
            foregroundDistance >= 0.16 ||
            coverage >= 0.012 ||
            (foregroundDistance >= 0.08 && coverage >= 0.004);
          const signalStrength = hasUsableSignal
            ? clamp01(foregroundDistance * 2.4 + coverage * 20)
            : 0;
          return {
            bg,
            data,
            fg,
            foregroundDistance,
            hasUsableSignal,
            height,
            ink,
            mask,
            signalStrength,
            width,
          };
        };
        const renderCandidate = ({ family, fontSize, fontWeight, height, lineHeight, lines, text, width }) => {
          const renderCanvas = document.createElement('canvas');
          renderCanvas.width = width;
          renderCanvas.height = height;
          const renderCtx = renderCanvas.getContext('2d', { willReadFrequently: true });
          if (!renderCtx) return null;
          renderCtx.clearRect(0, 0, width, height);
          renderCtx.fillStyle = '#000';
          renderCtx.font = fontWeight + ' ' + fontSize + 'px ' + family;
          renderCtx.textBaseline = 'alphabetic';
          const renderLines = Array.isArray(lines) && lines.length ? lines : [text];
          const lineMetrics = renderLines.map((line) => {
            const metrics = renderCtx.measureText(line);
            const left = Number(metrics.actualBoundingBoxLeft ?? 0);
            const right = Number(metrics.actualBoundingBoxRight ?? metrics.width ?? 0);
            const ascent = Number(metrics.actualBoundingBoxAscent ?? fontSize * 0.8);
            const descent = Number(metrics.actualBoundingBoxDescent ?? fontSize * 0.2);
            return {
              ascent,
              descent,
              left,
              text: line,
              width: Math.max(1, left + right),
            };
          });
          const measuredWidth = Math.max(1, ...lineMetrics.map((item) => item.width));
          const maxLineHeight = Math.max(1, ...lineMetrics.map((item) => item.ascent + item.descent));
          const measuredHeight = renderLines.length > 1
            ? Math.max(1, Number(lineHeight ?? maxLineHeight) * (renderLines.length - 1) + maxLineHeight)
            : maxLineHeight;
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
            lineMetrics.forEach((metrics, index) => {
              renderCtx.fillText(
                metrics.text,
                offsetX - metrics.left,
                offsetY + metrics.ascent + Number(lineHeight ?? maxLineHeight) * index,
              );
            });
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

        const hexLuminance = (hex) => {
          if (!hex || hex.length < 4) return 0;
          const h = hex.startsWith('#') ? hex.slice(1) : hex;
          const r = parseInt(h.length >= 6 ? h.slice(0, 2) : h[0] + h[0], 16);
          const g = parseInt(h.length >= 6 ? h.slice(2, 4) : h[1] + h[1], 16);
          const b = parseInt(h.length >= 6 ? h.slice(4, 6) : h[2] + h[2], 16);
          return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
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
          const weightColorFactor = 1 + hexLuminance(currentColor) * 3;
          const styleMetricWeight =
            typeof block.styleMetricWeight === 'number' && Number.isFinite(block.styleMetricWeight)
              ? Math.max(0, block.styleMetricWeight)
              : 0;
          const lineCount =
            typeof block.lineCount === 'number' && Number.isFinite(block.lineCount) && block.lineCount >= 1
              ? Math.round(block.lineCount)
              : 1;
          const lineHeightTarget =
            typeof block.lineHeight === 'number' && Number.isFinite(block.lineHeight)
              ? block.lineHeight
              : lineCount > 1
                ? Math.round(block.region.height / lineCount)
                : null;
          const styleTargetHeight = lineCount > 1
            ? styleTarget.height / lineCount
            : styleTarget.height;
          const fontSizeTarget = lineCount > 1
            ? Math.max(8, Math.round((lineHeightTarget ?? styleTargetHeight) * 0.84))
            : styleTargetHeight;
          const compactMetricSizing = lineCount === 1 && usesCompactMetricSizing(text);
          const families = currentFamily
            ? [currentFamily, ...fontFamilies.filter((family) => family !== currentFamily)]
            : fontFamilies;
          const weights = ['400', '500', '600', '650', '700', '750', '800', '900', '950'];
          const targetPhysical = {
            x: target.x * renderScale,
            y: target.y * renderScale,
            width: target.width * renderScale,
            height: target.height * renderScale,
          };
          const targetCrop = cropTarget(targetPhysical);
          if (currentWeight && !weights.includes(String(currentWeight))) {
            weights.unshift(String(currentWeight));
          }
          const sizes = sizeRange(fontSizeTarget);
          if (currentSize && !sizes.includes(Math.round(currentSize))) {
            sizes.push(Math.round(currentSize));
            sizes.sort((left, right) => left - right);
          }

          const betterCandidate = (candidate, best) =>
            !best || candidate.fit.score < best.fit.score;
          const buildCandidate = ({ family, fontSize, fontWeight }) => {
            const renderFontSize = Math.max(1, fontSize * renderScale);
            const targetPhysicalWidth = target.width * renderScale;
            const targetPhysicalBlockHeight = target.height * renderScale;
            const styleTargetPhysicalWidth = styleTarget.width * renderScale;
            const targetLineHeightPhysical =
              Math.max(1, (lineHeightTarget ?? styleTargetHeight) * renderScale);
            const targetPhysicalHeight = targetPhysicalBlockHeight;
            const styleTargetPhysicalHeight = styleTarget.height * renderScale;
            const targetCssHeight = clusteredStyleHeight(fontSizeTarget);
            const measuredFontSizeTarget = (() => {
              if (!compactMetricSizing) return targetCssHeight;
              const reference = measure({
                family,
                fontSize: 100,
                fontWeight,
                text,
              });
              const heightRatio = reference.height / 100;
              if (!Number.isFinite(heightRatio) || heightRatio <= 0) {
                return targetCssHeight;
              }
              return Math.max(
                targetCssHeight,
                targetCssHeight / Math.max(0.55, Math.min(1.05, heightRatio)),
              );
            })();
            const candidateLines = lineCount > 1
              ? wrapText({
                  family,
                  fontSize: renderFontSize,
                  fontWeight,
                  maxWidth: targetPhysicalWidth,
                  text,
                })
              : [text];
            const base = lineCount > 1
              ? measureLines({
                  family,
                  fontSize: renderFontSize,
                  fontWeight,
                  lineHeight: targetLineHeightPhysical,
                  lines: candidateLines,
                })
              : measure({
                  family,
                  fontSize: renderFontSize,
                  fontWeight,
                  text,
                });
            const widthDelta = base.width - targetPhysicalWidth;
            if (widthDelta > targetPhysicalWidth * maxAcceptedWidthOverflowRatio) {
              return null;
            }
            const heightDelta = lineCount > 1 ? 0 : base.height - targetPhysicalHeight;
            const styleWidthDelta = base.width - styleTargetPhysicalWidth;
            const styleHeightDelta = lineCount > 1 ? 0 : base.height - styleTargetPhysicalHeight;
            const lineCountDelta = lineCount > 1
              ? Math.abs(candidateLines.length - lineCount)
              : 0;
            const visualFontSizePrior =
              Math.abs(fontSize - measuredFontSizeTarget) * (compactMetricSizing ? 2.8 : 4.5) +
              Math.max(0, measuredFontSizeTarget - fontSize) * (compactMetricSizing ? 1.2 : 2) +
              Math.max(0, fontSize - measuredFontSizeTarget) * (compactMetricSizing ? 0.9 : 1.25);
            const widthFitPrior =
              (Math.abs(widthDelta) / Math.max(1, targetPhysicalWidth)) * 14;
            const familyIndex = Math.max(0, families.indexOf(family));
            const familyPrior = familyIndex * 2;
            const visualSignalStrength = Number(targetCrop?.signalStrength ?? 0);
            const weightPrior =
              (Math.abs(Number(fontWeight) - Number(neutralWeight)) / 100 * 1.5 +
              Math.max(0, Number(fontWeight) - Number(neutralWeight)) / 100 * 2.5) *
              weightColorFactor *
              (visualSignalStrength > 0
                ? Math.max(0.25, 1 - visualSignalStrength * 0.65)
                : 1);
            const visual =
              targetCrop?.hasUsableSignal
                ? compareVisual(
                    targetCrop,
                    renderCandidate({
                      family,
                      fontSize: renderFontSize,
                      fontWeight,
                      height: Math.max(1, Math.ceil(targetCrop?.height ?? targetPhysicalHeight)),
                      lineHeight: targetLineHeightPhysical,
                      lines: candidateLines,
                      text,
                      width: Math.max(1, Math.ceil(targetCrop?.width ?? targetPhysicalWidth)),
                    }),
                  )
                : null;
            const score = visual
              ? visual.score +
                widthFitPrior +
                Math.abs(styleWidthDelta) * styleMetricWeight +
                Math.abs(styleHeightDelta) * styleMetricWeight +
                visualFontSizePrior +
                lineCountDelta * 80 +
                familyPrior +
                weightPrior
              : Math.abs(widthDelta) * 1.1 +
                Math.abs(heightDelta) * 1.1 +
                widthFitPrior +
                Math.abs(styleWidthDelta) * styleMetricWeight +
                Math.abs(styleHeightDelta) * styleMetricWeight +
                visualFontSizePrior +
                lineCountDelta * 80 +
                familyPrior +
                weightPrior;
            return {
              declarations: {
                ...(currentColor || targetCrop?.fg
                  ? { 'color': currentColor || rgbToHex(targetCrop.fg) }
                  : {}),
                'font-family': family,
                'font-size': fontSize + 'px',
                'font-weight': String(fontWeight),
                'line-height': Math.max(
                  1,
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
          };

          const neutralWeight = currentWeight && weights.includes(String(currentWeight))
            ? String(currentWeight)
            : '400';
          const sizePassCandidates = [];
          for (const family of families) {
            for (const fontSize of sizes) {
              const candidate = buildCandidate({
                family,
                fontSize,
                fontWeight: neutralWeight,
              });
              if (candidate) {
                sizePassCandidates.push({
                  candidate,
                  family,
                  fontSize,
                });
              }
            }
          }

          const bestSizeCandidate = sizePassCandidates.sort(
            (left, right) => left.candidate.fit.score - right.candidate.fit.score,
          )[0];
          const selectedFontSize =
            parsePx(bestSizeCandidate?.candidate.declarations?.['font-size']) ??
            currentSize ??
            sizes[0];
          const selectedFontSizes = [...new Set([
            selectedFontSize,
            selectedFontSize - 1,
            selectedFontSize + 1,
            ...sizePassCandidates
              .slice(0, 6)
              .map((item) => item.fontSize),
          ])]
            .filter((value) => Number.isFinite(value) && sizes.includes(value))
            .sort((left, right) => left - right);
          let best = null;
          for (const family of families) {
            for (const fontSize of selectedFontSizes) {
              for (const fontWeight of weights) {
                const candidate = buildCandidate({
                  family,
                  fontSize,
                  fontWeight,
                });
                if (candidate && betterCandidate(candidate, best)) {
                  best = candidate;
                }
              }
            }
          }

          if (!best) {
            const fallbackSize = selectedFontSize ?? sizes[0] ?? 16;
            const fallbackLineHeight = Math.max(
              fallbackSize,
              Math.round(lineHeightTarget ?? styleTarget.height ?? fallbackSize),
            );
            return {
              id: block.id,
              text,
              region: target,
              declarations: {
                'font-family': families[0] ?? 'sans-serif',
                'font-size': fallbackSize + 'px',
                'font-weight': String(weights[0] ?? '400'),
                'line-height': fallbackLineHeight + 'px',
              },
              fit: { score: 0 },
            };
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
