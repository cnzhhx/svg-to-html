import path from "node:path";

import { toAbsolutePath } from "./paths.js";

type OutputFormat = "html" | "vue" | "react";

type SessionOutputTarget = {
  compareEntryPath: string;
  format: OutputFormat;
  frameworkBuildDir?: string;
  renderEntryPath: string;
  sourceEntryPath: string;
  sourceStylePath?: string;
};

const OUTPUT_FORMATS: OutputFormat[] = ["html", "vue", "react"];

const isOutputFormat = (value: unknown): value is OutputFormat =>
  typeof value === "string" &&
  OUTPUT_FORMATS.includes(value.trim().toLowerCase() as OutputFormat);

const parseOutputFormat = (value: unknown): OutputFormat => {
  if (isOutputFormat(value)) return value.trim().toLowerCase() as OutputFormat;
  throw new Error(
    `Invalid outputFormat: ${String(value ?? "")} (expected html, vue, or react)`,
  );
};

const getOutputFormatLabel = (format: OutputFormat) => {
  if (format === "vue") return "Vue";
  if (format === "react") return "React";
  return "HTML";
};

const normalizeOutputFormat = (value: unknown): OutputFormat => {
  if (isOutputFormat(value)) return value.trim().toLowerCase() as OutputFormat;
  return "html";
};

const assertOutputFormat = (value: unknown): OutputFormat => {
  if (isOutputFormat(value)) return value.trim().toLowerCase() as OutputFormat;
  throw new Error(`Unsupported outputFormat: ${String(value)}`);
};

const getSourceFragmentFileName = (outputFormat: OutputFormat) => {
  if (outputFormat === "vue") return "source.fragment.vue.html";
  if (outputFormat === "react") return "source.fragment.jsx";
  return "preview.fragment.html";
};

const resolveOutputTarget = ({
  format,
  svgPath,
}: {
  format: OutputFormat;
  svgPath: string;
}): SessionOutputTarget => {
  const absoluteSvgPath = toAbsolutePath(svgPath);
  const ext = path.extname(absoluteSvgPath);
  const basePath = ext ? absoluteSvgPath.slice(0, -ext.length) : absoluteSvgPath;
  const artifactDir = path.join(path.dirname(absoluteSvgPath), "artifacts");
  const renderEntryPath = toAbsolutePath(`${basePath}.html`);
  const compareEntryPath = toAbsolutePath(`${basePath}.compare.html`);

  if (format === "vue") {
    return {
      compareEntryPath,
      format,
      frameworkBuildDir: path.join(artifactDir, "framework-render", "vue"),
      renderEntryPath,
      sourceEntryPath: toAbsolutePath(`${basePath}.vue`),
    };
  }

  if (format === "react") {
    return {
      compareEntryPath,
      format,
      frameworkBuildDir: path.join(artifactDir, "framework-render", "react"),
      renderEntryPath,
      sourceEntryPath: toAbsolutePath(`${basePath}.tsx`),
      sourceStylePath: toAbsolutePath(`${basePath}.css`),
    };
  }

  return {
    compareEntryPath,
    format,
    renderEntryPath,
    sourceEntryPath: renderEntryPath,
  };
};

export {
  assertOutputFormat,
  getOutputFormatLabel,
  getSourceFragmentFileName,
  isOutputFormat,
  normalizeOutputFormat,
  parseOutputFormat,
  resolveOutputTarget,
};
export type { OutputFormat, SessionOutputTarget };
