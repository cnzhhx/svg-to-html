import path from "node:path";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";

const defaultWorkspaceRoot = () =>
  path.resolve(
    process.env["WORKSPACE"] ?? path.join(process.cwd(), "workspace"),
  );

let workspaceRoot = defaultWorkspaceRoot();

const setWorkspaceRoot = (root: string) => {
  workspaceRoot = path.resolve(root);
};

const getWorkspaceRoot = () => workspaceRoot;

const isInsidePath = (basePath: string, targetPath: string) => {
  const relativePath = path.relative(basePath, targetPath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
};

type DesignPair = {
  compareHtmlPath: string;
  designName: string;
  width: number;
  height: number;
  htmlPath: string;
  scale: number;
  svgPath: string;
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

const parseSvgSize = async (svgPath: string, scale = DEFAULT_SCALE) => {
  const svg = await readFile(svgPath, "utf8");
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

  const viewBoxNumbers = getAttr("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number)
    .filter(Number.isFinite);
  if (viewBoxNumbers && viewBoxNumbers.length >= 4) {
    return {
      width: Math.round(viewBoxNumbers[2]! * scale),
      height: Math.round(viewBoxNumbers[3]! * scale),
    };
  }

  const width = parseNumber(getAttr("width"));
  const height = parseNumber(getAttr("height"));
  if (width !== undefined && height !== undefined) {
    return {
      width: Math.round(width * scale),
      height: Math.round(height * scale),
    };
  }

  throw new Error(`Unable to read SVG size: ${svgPath}`);
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
): Promise<DesignPair> => {
  const scale = options?.scale ?? DEFAULT_SCALE;
  const ext = path.extname(inputPath);
  const basePath = ext ? inputPath.slice(0, -ext.length) : inputPath;
  const svgPath = toAbsolutePath(`${basePath}.svg`);
  const htmlPath = toAbsolutePath(`${basePath}.html`);
  const compareHtmlPath = toAbsolutePath(`${basePath}.compare.html`);

  await assertFile(svgPath, "SVG");
  const { width, height } = await parseSvgSize(svgPath, scale);

  return {
    compareHtmlPath,
    svgPath,
    htmlPath,
    designName: path.basename(basePath),
    scale,
    width,
    height,
  };
};

const resolveDesignPair = async (inputPath: string, options?: { scale?: number }): Promise<DesignPair> => {
  const design = await resolveSvgDesign(inputPath, options);
  await assertFile(design.htmlPath, "HTML");
  return design;
};

const resolveArtifactDir = async (inputPath: string, customPath?: string) => {
  const resolvedInputPath = toAbsolutePath(inputPath);
  const artifactDir = toAbsolutePath(
    customPath ?? path.join(path.dirname(resolvedInputPath), "artifacts"),
  );
  await mkdir(artifactDir, { recursive: true });
  return artifactDir;
};

const readRegions = async (regionsPath?: string): Promise<Region[]> => {
  if (!regionsPath || regionsPath === "-") return [];
  const normalizedPath = toAbsolutePath(regionsPath);
  await assertFile(normalizedPath, "Regions JSON");
  const regions = JSON.parse(
    await readFile(normalizedPath, "utf8"),
  ) as Region[];
  if (!regions?.length) return [];
  return regions;
};

const writeTextFile = async (filePath: string, content: string) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  return filePath;
};

const writeJsonFile = async (filePath: string, payload: unknown) => {
  await writeTextFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
};

export type { Box } from "./geometry.js";
export type { DesignPair, Region };
export {
  assertFile,
  getWorkspaceRoot,
  isInsidePath,
  parseSvgSize,
  readRegions,
  resolveArtifactDir,
  resolveDesignPair,
  resolveSvgDesign,
  setWorkspaceRoot,
  toAbsolutePath,
  toUrlPath,
  writeJsonFile,
  writeTextFile,
};
