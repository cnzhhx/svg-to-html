import path from "node:path";
import { mkdir } from "node:fs/promises";

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

const resolveArtifactDir = async (inputPath: string, customPath?: string) => {
  const resolvedInputPath = toAbsolutePath(inputPath);
  const artifactDir = toAbsolutePath(
    customPath ?? path.join(path.dirname(resolvedInputPath), "artifacts"),
  );
  await mkdir(artifactDir, { recursive: true });
  return artifactDir;
};

export {
  getWorkspaceRoot,
  isInsidePath,
  resolveArtifactDir,
  setWorkspaceRoot,
  toAbsolutePath,
  toUrlPath,
};
