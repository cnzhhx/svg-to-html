import path from "node:path";
import { readFile, writeFile, mkdir, stat, rename, rm } from "node:fs/promises";

import type { OutputFormat, SessionOutputTarget } from "./output-target.js";
import { resolveOutputTarget } from "./output-target.js";

const defaultWorkspaceRoot = () =>
  path.resolve(
    process.env["WORKSPACE"] ?? path.join(process.cwd(), "workspace"),
  );

let workspaceRoot = defaultWorkspaceRoot();

const setWorkspaceRoot = (root: string) => {
  workspaceRoot = path.resolve(root);
};

const getWorkspaceRoot = () => workspaceRoot;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isInsidePath = (basePath: string, targetPath: string) => {
  const relativePath = path.relative(basePath, targetPath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
};

type ResolvedSvgDesign = {
  designName: string;
  width: number;
  height: number;
  scale: number;
  svgPath: string;
};

type ResolvedDesignTarget = ResolvedSvgDesign & {
  outputFormat: OutputFormat;
  outputTarget: SessionOutputTarget;
};

type ResolvedRenderTarget = ResolvedSvgDesign & {
  renderEntryPath: string;
};

type Region = {
  id?: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

const toAbsolutePath = (inputPath: string) => {
  if (path.isAbsolute(inputPath)) return inputPath;
  // Prevent double workspace prefix: if the relative path already starts with
  // the workspace directory name (e.g. "workspace/sessions/..."), resolve from
  // the parent of workspaceRoot so we don't produce "workspace/workspace/...".
  const wsBaseName = path.basename(workspaceRoot);
  if (
    inputPath === wsBaseName ||
    inputPath.startsWith(`${wsBaseName}/`) ||
    inputPath.startsWith(`${wsBaseName}\\`)
  ) {
    return path.resolve(path.dirname(workspaceRoot), inputPath);
  }
  return path.resolve(workspaceRoot, inputPath);
};

const toUrlPath = (inputPath: string) => {
  const abs = toAbsolutePath(inputPath);
  const repoRoot = path.resolve(process.cwd());
  const repoRelativePath = path.relative(repoRoot, abs);

  if (isInsidePath(repoRoot, abs)) {
    return `/${repoRelativePath.replace(/\\/g, "/")}`;
  }

  const workspaceRelativePath = path.relative(workspaceRoot, abs);
  if (isInsidePath(workspaceRoot, abs)) {
    const suffix = workspaceRelativePath
      ? `/${workspaceRelativePath.replace(/\\/g, "/")}`
      : "";
    return `/__workspace${suffix}`;
  }

  throw new Error(`Path is outside repo root and workspace root: ${inputPath}`);
};

const DEFAULT_SCALE = 1;

type SvgDimensions = {
  height: number;
  width: number;
};

const readSvgDimensions = (svg: string): SvgDimensions | null => {
  const svgOpen = svg.match(/<svg\b([^>]*)>/i);
  const attrs = svgOpen?.[1] ?? "";
  const getAttr = (name: string) => {
    const match = attrs.match(
      new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
    );
    return match?.[1] ?? match?.[2] ?? match?.[3];
  };
  const parseNumber = (value: string | undefined) => {
    const match = value?.match(/-?\d+(?:\.\d+)?/);
    if (!match) return undefined;
    const parsed = Number(match[0]);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const viewBox = getAttr("viewBox");
  const viewBoxNumbers = viewBox
    ?.trim()
    .split(/[\s,]+/)
    .map(Number)
    .filter(Number.isFinite);
  if (viewBoxNumbers && viewBoxNumbers.length >= 4) {
    const width = viewBoxNumbers[2]!;
    const height = viewBoxNumbers[3]!;
    if (width > 0 && height > 0) {
      return { height: Math.ceil(height), width: Math.ceil(width) };
    }
  }

  const width = parseNumber(getAttr("width"));
  const height = parseNumber(getAttr("height"));
  if (width !== undefined && height !== undefined && width > 0 && height > 0) {
    return { height: Math.ceil(height), width: Math.ceil(width) };
  }

  return null;
};

const parseSvgSize = async (svgPath: string, scale = DEFAULT_SCALE) => {
  const svg = await readFile(svgPath, "utf8");
  const dims = readSvgDimensions(svg);
  if (!dims) {
    throw new Error(`Unable to read SVG size: ${svgPath}`);
  }
  return {
    width: Math.round(dims.width * scale),
    height: Math.round(dims.height * scale),
  };
};

const assertFile = async (filePath: string, label: string) => {
  try {
    await stat(filePath);
  } catch {
    throw new Error(`${label} not found: ${filePath}`);
  }
};

const resolveSvgDesign = async (
  inputPath: string,
  options?: { scale?: number },
): Promise<ResolvedSvgDesign> => {
  const scale = options?.scale ?? DEFAULT_SCALE;
  const ext = path.extname(inputPath);
  const basePath = ext ? inputPath.slice(0, -ext.length) : inputPath;
  const svgPath = toAbsolutePath(`${basePath}.svg`);

  await assertFile(svgPath, "SVG");
  const { width, height } = await parseSvgSize(svgPath, scale);

  return {
    svgPath,
    designName: path.basename(basePath),
    scale,
    width,
    height,
  };
};

const resolveDesignTarget = async (
  inputPath: string,
  options: { format: OutputFormat; scale?: number },
): Promise<ResolvedDesignTarget> => {
  const design = await resolveSvgDesign(inputPath, options);
  return {
    ...design,
    outputFormat: options.format,
    outputTarget: resolveOutputTarget({
      format: options.format,
      svgPath: design.svgPath,
    }),
  };
};

const resolveRenderTarget = async (
  inputPath: string,
  options: { renderEntryPath: string; scale?: number },
): Promise<ResolvedRenderTarget> => {
  const design = await resolveSvgDesign(inputPath, options);
  const renderEntryPath = toAbsolutePath(options.renderEntryPath);
  await assertFile(renderEntryPath, "Render entry");
  return {
    ...design,
    renderEntryPath,
  };
};

const resolveArtifactDir = async (inputPath: string, customPath?: string) => {
  const resolvedInputPath = toAbsolutePath(inputPath);
  const artifactDir = toAbsolutePath(
    customPath ?? path.join(path.dirname(resolvedInputPath), "artifacts"),
  );
  await mkdir(artifactDir, { recursive: true });
  return artifactDir;
};

const writeTextFile = async (filePath: string, content: string) => {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random()
      .toString(16)
      .slice(2)}.tmp`,
  );
  try {
    await writeFile(tmpPath, content, "utf8");
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
  return filePath;
};

const writeJsonFile = async (filePath: string, payload: unknown) => {
  await writeTextFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
};

/**
 * Ensure the SVG has an explicit viewBox attribute. Without a viewBox, browsers
 * will NOT scale SVG content when the CSS box size differs from the intrinsic
 * width/height attributes. This means getBoundingClientRect() returns original
 * SVG coordinates instead of scaled pixels, breaking the pipeline's assumption
 * that pixelBox values are in rendered (scaled) coordinates.
 */
const ensureSvgViewBox = (markup: string): string => {
  const svgOpenMatch = markup.match(/<svg\b([^>]*)>/i);
  if (!svgOpenMatch) return markup;
  const attrs = svgOpenMatch[1] ?? "";

  // Already has a viewBox — nothing to do.
  if (/\bviewBox\s*=/i.test(attrs)) return markup;

  // Extract intrinsic width/height to derive a viewBox.
  const widthMatch = attrs.match(
    /\bwidth\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i,
  );
  const heightMatch = attrs.match(
    /\bheight\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i,
  );
  const parseNum = (m: RegExpMatchArray | null) => {
    const raw = m?.[1] ?? m?.[2] ?? m?.[3];
    const num = raw ? Number.parseFloat(raw) : NaN;
    return Number.isFinite(num) && num > 0 ? num : undefined;
  };
  const w = parseNum(widthMatch);
  const h = parseNum(heightMatch);
  if (!w || !h) return markup;

  // Inject viewBox right after the opening <svg tag so content scales properly.
  const viewBox = `viewBox="0 0 ${w} ${h}"`;
  return markup.replace(/<svg\b/i, `<svg ${viewBox}`);
};

const parsePositiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.floor(parsed));
};

const parseNonNegativeInteger = (
  value: string | undefined,
  fallback: number,
) => {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
};

type RootChildElement = {
  closeTag: string;
  content: string;
  innerContent: string;
  nthOfType: number;
  openTag: string;
  pathSegment: string;
  selfClosing: boolean;
  tag: string;
};

const findTagEnd = (content: string, start: number) => {
  let quote: null | string = null;
  for (let index = start; index < content.length; index += 1) {
    const char = content[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return index;
  }
  return -1;
};

const readTag = (tagSource: string) => {
  const match = tagSource.match(/^<\/?\s*([a-zA-Z][\w:.-]*)/);
  return match?.[1]?.toLowerCase();
};

const isSelfClosingTag = (tagSource: string) => /\/\s*>$/.test(tagSource);

const findElementEnd = ({
  content,
  openEnd,
  startTag,
}: {
  content: string;
  openEnd: number;
  startTag: string;
}) => {
  if (isSelfClosingTag(content.slice(0, openEnd + 1))) return openEnd + 1;

  let cursor = openEnd + 1;
  let depth = 1;
  while (cursor < content.length) {
    const nextOpen = content.indexOf("<", cursor);
    if (nextOpen === -1) return content.length;
    if (content.startsWith("<!--", nextOpen)) {
      const commentEnd = content.indexOf("-->", nextOpen + 4);
      cursor = commentEnd === -1 ? content.length : commentEnd + 3;
      continue;
    }
    if (content.startsWith("<![CDATA[", nextOpen)) {
      const cdataEnd = content.indexOf("]]>", nextOpen + 9);
      cursor = cdataEnd === -1 ? content.length : cdataEnd + 3;
      continue;
    }
    const tagEnd = findTagEnd(content, nextOpen);
    if (tagEnd === -1) return content.length;
    const tagSource = content.slice(nextOpen, tagEnd + 1);
    const tag = readTag(tagSource);
    if (tag === startTag) {
      if (tagSource.startsWith("</")) {
        depth -= 1;
        if (depth === 0) return tagEnd + 1;
      } else if (!isSelfClosingTag(tagSource)) {
        depth += 1;
      }
    }
    cursor = tagEnd + 1;
  }
  return content.length;
};

const parseRootChildElements = (content: string): RootChildElement[] => {
  const children: RootChildElement[] = [];
  const siblingCounts = new Map<string, number>();
  let cursor = 0;

  while (cursor < content.length) {
    const nextOpen = content.indexOf("<", cursor);
    if (nextOpen === -1) break;
    if (
      content.startsWith("<!--", nextOpen) ||
      content.startsWith("<?", nextOpen) ||
      content.startsWith("<!", nextOpen)
    ) {
      const closeToken = content.startsWith("<!--", nextOpen) ? "-->" : ">";
      const closeIndex = content.indexOf(closeToken, nextOpen + 2);
      cursor =
        closeIndex === -1 ? content.length : closeIndex + closeToken.length;
      continue;
    }

    const openEnd = findTagEnd(content, nextOpen);
    if (openEnd === -1) break;
    const tagSource = content.slice(nextOpen, openEnd + 1);
    if (tagSource.startsWith("</")) {
      cursor = openEnd + 1;
      continue;
    }
    const tag = readTag(tagSource);
    if (!tag) {
      cursor = openEnd + 1;
      continue;
    }

    const elementEnd = findElementEnd({
      content: content.slice(nextOpen),
      openEnd: openEnd - nextOpen,
      startTag: tag,
    });
    const rawElement = content.slice(nextOpen, nextOpen + elementEnd);
    const openTag = content.slice(nextOpen, openEnd + 1);
    const selfClosing = isSelfClosingTag(openTag);
    const closeStart = selfClosing
      ? -1
      : rawElement.toLowerCase().lastIndexOf(`</${tag}`);
    const innerContent =
      !selfClosing && closeStart >= 0
        ? rawElement.slice(openTag.length, closeStart)
        : "";
    const closeTag =
      !selfClosing && closeStart >= 0 ? rawElement.slice(closeStart) : "";
    const nthOfType = (siblingCounts.get(tag) ?? 0) + 1;
    siblingCounts.set(tag, nthOfType);
    children.push({
      closeTag,
      content: rawElement,
      innerContent,
      nthOfType,
      openTag,
      pathSegment: `${tag}:nth-of-type(${nthOfType})`,
      selfClosing,
      tag,
    });
    cursor = nextOpen + elementEnd;
  }

  return children;
};

export type { Box } from "./geometry.js";
export type {
  Region,
  ResolvedDesignTarget,
  ResolvedSvgDesign,
  RootChildElement,
};
export {
  assertFile,
  ensureSvgViewBox,
  findElementEnd,
  findTagEnd,
  getWorkspaceRoot,
  isInsidePath,
  isRecord,
  isSelfClosingTag,
  parsePositiveInteger,
  parseNonNegativeInteger,
  parseRootChildElements,
  parseSvgSize,
  readSvgDimensions,
  readTag,
  resolveArtifactDir,
  resolveDesignTarget,
  resolveRenderTarget,
  resolveSvgDesign,
  setWorkspaceRoot,
  toAbsolutePath,
  toUrlPath,
  writeJsonFile,
  writeTextFile,
};
