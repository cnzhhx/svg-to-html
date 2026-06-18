import path from "node:path";

import { getWorkspaceRoot, isInsidePath } from '../paths.js';

const COMPONENT_LIBRARY_ROOT_DIR = "component-libraries";
const COMPONENT_LIBRARY_DESCRIPTOR_FILE = "component-library.json";
const COMPONENT_LIBRARY_META_FILE = "component-library.meta.json";
const COMPONENT_LIBRARY_SOURCE_DIR = "source";

const getComponentLibrariesRoot = () =>
  path.join(getWorkspaceRoot(), COMPONENT_LIBRARY_ROOT_DIR);

const assertSafeComponentLibraryId = (id: string) => {
  if (/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/.test(id)) return;
  throw new Error(
    `Invalid component library id "${id}". Use letters, numbers, dot, underscore, or dash.`,
  );
};

const normalizeComponentLibraryId = (value: string) => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/g, "")
    .slice(0, 80);
  return normalized || `component-library-${Date.now().toString(36)}`;
};

const resolveComponentLibraryDir = (id: string) => {
  assertSafeComponentLibraryId(id);
  const root = getComponentLibrariesRoot();
  const dir = path.join(root, id);
  if (!isInsidePath(root, dir)) {
    throw new Error(`Component library path escapes workspace: ${id}`);
  }
  return dir;
};

const resolveComponentLibraryPaths = (id: string) => {
  const dir = resolveComponentLibraryDir(id);
  return {
    descriptorPath: path.join(dir, COMPONENT_LIBRARY_DESCRIPTOR_FILE),
    dir,
    metaPath: path.join(dir, COMPONENT_LIBRARY_META_FILE),
    sourceDir: path.join(dir, COMPONENT_LIBRARY_SOURCE_DIR),
  };
};

export {
  getComponentLibrariesRoot,
  normalizeComponentLibraryId,
  resolveComponentLibraryPaths,
};
