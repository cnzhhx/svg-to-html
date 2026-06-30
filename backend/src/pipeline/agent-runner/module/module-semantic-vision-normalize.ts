import {
  readString,
  type ModuleSemanticNodeSemantic,
} from "./module-semantic.js";

type VisionNodeSemantic = {
  isPureText?: boolean;
  id?: string;
  text?: string;
  lineCount?: number;
  contentType?: string;
  visualLines?: string[];
};

const MISSING_TEXT_RECHECK_NOTE =
  "Vision output looked text-like but omitted readable text; downgraded until recheck resolves it.";

const JSON_MARKDOWN_RE = /^```(?:json)?\s*|\s*```$/gi;

const VALID_CONTENT_TYPES = new Set([
  "cover",
  "photo",
  "icon",
  "badge",
  "avatar",
  "background",
  "decoration",
  "unknown",
]);

const stripJsonMarkdown = (raw: string) => {
  let content = raw.trim();
  // Strip <think>...</think> tags (reasoning content from some models)
  content = content.replace(/<think>.*?<\/think>/gs, "");
  content = content.replace(/<think>/g, "");
  content = content.replace(/<\/think>/g, "");
  content = content.trim();
  content = content.replace(JSON_MARKDOWN_RE, "");
  const arrayStart = content.indexOf("[");
  const arrayEnd = content.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    return content.slice(arrayStart, arrayEnd + 1);
  }
  return content;
};

const normalizeInlineText = (value: string) =>
  value.replace(/\s+/g, " ").trim();

const normalizeDomText = (value: string) =>
  value
    .split(/\r?\n/)
    .map((line) => normalizeInlineText(line))
    .filter((line) => line.length > 0)
    .join("\n");

const normalizeVisualLineText = (value: unknown) =>
  typeof value === "string" ? normalizeInlineText(value) : undefined;

const readVisionVisualLines = (
  input: VisionNodeSemantic,
): string[] => {
  if (!Array.isArray(input.visualLines)) return [];
  return input.visualLines.flatMap((line) => {
    const text = normalizeVisualLineText(line);
    return text ? [text] : [];
  });
};

const mergeVisualLinesForDomText = ({
  fallbackText,
  visualLines,
}: {
  fallbackText: string;
  visualLines: string[];
}) => {
  const lines = visualLines
    .map((line) => normalizeInlineText(line))
    .filter((text) => text.length > 0);
  if (lines.length === 0) return normalizeDomText(fallbackText);
  return lines.join("\n");
};

const normalizeVisionNodeSemantic = (
  input: VisionNodeSemantic,
): ModuleSemanticNodeSemantic => {
  const visionMarkedPureText = input.isPureText === true;
  const visualLines = readVisionVisualLines(input);
  const rawText =
    mergeVisualLinesForDomText({
      fallbackText: readString(input.text) ?? "",
      visualLines,
    }) || readString(input.text);
  const rawContentType = readString(input.contentType);
  const contentType =
    rawContentType && VALID_CONTENT_TYPES.has(rawContentType)
      ? rawContentType
      : "unknown";

  if (visionMarkedPureText && !rawText) {
    return {
      containsReadableText: false,
      contentType,
      exportDecision: "export",
      kind: "unknown",
      notes: MISSING_TEXT_RECHECK_NOTE,
      textHandling: "ignore",
    };
  }
  const isPureText = visionMarkedPureText && Boolean(rawText);

  const lineCount =
    typeof input.lineCount === "number" && Number.isFinite(input.lineCount) && input.lineCount >= 1
      ? Math.round(input.lineCount)
      : visualLines.length > 0
        ? visualLines.length
      : undefined;

  return {
    containsReadableText: isPureText || Boolean(rawText),
    contentType,
    exportDecision: isPureText ? "skip" : "export",
    kind: isPureText ? "text" : rawText ? "visual-text" : "unknown",
    lineCount,
    text: rawText,
    textHandling: isPureText
      ? "dom-text"
      : rawText
        ? "export-asset"
        : "ignore",
    ...(visualLines.length > 0 ? { visualLines } : {}),
  };
};

export {
  MISSING_TEXT_RECHECK_NOTE,
  mergeVisualLinesForDomText,
  normalizeDomText,
  normalizeInlineText,
  normalizeVisionNodeSemantic,
  readVisionVisualLines,
  stripJsonMarkdown,
};
export type { VisionNodeSemantic };
