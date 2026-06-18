import path from "node:path";
import { readdir, readFile } from "node:fs/promises";

import type { ComponentLibraryDiscovery } from "../core/component-library/discovery.js";
import type { ComponentLibraryFramework } from "../core/component-library/types.js";

const TREE_EXCLUDED_DIRS = new Set([
  ".cache",
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  "coverage",
  "node_modules",
]);

const TREE_INTERESTING_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".mdx",
  ".mjs",
  ".scss",
  ".ts",
  ".tsx",
  ".vue",
]);

// Auxiliary repo context only. Component coverage comes from deterministic
// discovery and is not capped by this value.
const AUXILIARY_TREE_MAX_LINES = 500;

const readTextIfExists = async (filePath: string, maxChars: number) => {
  try {
    const text = await readFile(filePath, "utf8");
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n...` : text;
  } catch {
    return "";
  }
};

const findReadmePath = async (sourceDir: string) => {
  const entries = await readdir(sourceDir, { withFileTypes: true }).catch(
    () => [],
  );
  const readme = entries.find(
    (entry) => entry.isFile() && /^readme\.(md|mdx|txt)$/i.test(entry.name),
  );
  return readme ? path.join(sourceDir, readme.name) : undefined;
};

const collectTreeLines = async ({
  dir,
  maxDepth,
  maxLines,
  prefix = "",
  rootDir = dir,
}: {
  dir: string;
  maxDepth: number;
  maxLines: number;
  prefix?: string;
  rootDir?: string;
}): Promise<string[]> => {
  if (maxDepth < 0 || maxLines <= 0) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const sorted = entries
    .filter((entry) => {
      if (entry.isDirectory()) return !TREE_EXCLUDED_DIRS.has(entry.name);
      if (!entry.isFile()) return false;
      return TREE_INTERESTING_EXTENSIONS.has(path.extname(entry.name).toLowerCase());
    })
    .sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) {
        return left.isDirectory() ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });

  const lines: string[] = [];
  for (const entry of sorted) {
    if (lines.length >= maxLines) break;
    const absolute = path.join(dir, entry.name);
    const relative = path.relative(rootDir, absolute).replaceAll(path.sep, "/");
    lines.push(`${prefix}${entry.isDirectory() ? "dir " : "file "}${relative}`);
    if (entry.isDirectory()) {
      const childLines = await collectTreeLines({
        dir: absolute,
        maxDepth: maxDepth - 1,
        maxLines: maxLines - lines.length,
        prefix,
        rootDir,
      });
      lines.push(...childLines);
    }
  }
  return lines;
};

const buildDescriptorPrompt = async ({
  discovery,
  framework,
  id,
  sourceDir,
}: {
  discovery?: ComponentLibraryDiscovery;
  framework: ComponentLibraryFramework;
  id: string;
  sourceDir: string;
}) => {
  const packageJson = await readTextIfExists(
    path.join(sourceDir, "package.json"),
    8000,
  );
  const readmePath = await findReadmePath(sourceDir);
  const readme = readmePath ? await readTextIfExists(readmePath, 8000) : "";
  const tree = await collectTreeLines({
    dir: sourceDir,
    maxDepth: 5,
    maxLines: AUXILIARY_TREE_MAX_LINES,
  });
  const discoveredPackage = discovery?.packageInfo
    ? JSON.stringify(discovery.packageInfo, null, 2)
    : "(none)";
  const discoveredComponents = discovery?.components.length
    ? discovery.components
        .map((component) =>
          [
            `- ${component.name}`,
            `path=${component.path}`,
            component.importName ? `importName=${component.importName}` : undefined,
            component.importPath ? `importPath=${component.importPath}` : undefined,
            component.tag ? `tag=${component.tag}` : undefined,
          ]
            .filter(Boolean)
            .join(" | "),
        )
        .join("\n")
    : "(none)";

  return `
你要为一个 ${framework} 组件库生成极简 component-library.json。这个 JSON 只做组件目录摘要，给后续模块 agent 粗略判断候选组件；不要写完整 props/slots/events 文档。

硬性要求：
- 只输出 JSON 对象，不要输出 Markdown 或解释
- schemaVersion 必须是 1
- id 必须是 "${id}"
- framework 必须是 "${framework}"
- package.name 必须尽量使用 package.json 的 name；如果无法判断，使用 id
- package.importPath 默认等于 package.name
- package.importMode 只能是 "named" 或 "default"，优先使用 "named"
- components 是数组，每个组件必须包含 name 和 path
- “确定性发现的组件清单”是完整组件基线；components 必须覆盖清单中的每一项，不能因为代码树有界或文档较长而省略后半部分
- components[].path 必须是相对当前组件库代码根目录的路径，且路径必须真实存在
- 如果确定性发现项给出了 importName/importPath/tag，必须沿用；不要把大小写改成另一个猜测值
- components[].description/category/keywords/displayName/tag/importName/importPath/styleImports/docsPaths/examplePaths 可以按已有代码、README、文件名推断；不确定就省略或给简短描述
- docsPaths/examplePaths 必须是相对代码根目录且真实存在的文档、示例、story 或 demo 文件路径；只填对理解组件公开 API 有帮助的少量路径
- 不要臆造不存在的组件路径
- 不要把 demo/example 页面当组件，除非代码库没有其他明确组件入口

目标 JSON 结构：
{
  "schemaVersion": 1,
  "id": "${id}",
  "name": "组件库名称",
  "framework": "${framework}",
  "package": {
    "name": "<package-name>",
    "importPath": "<package-name>",
    "importMode": "named",
    "styleImports": []
  },
  "components": [
    {
      "name": "Button",
      "displayName": "Button",
      "category": "button",
      "description": "简短通用用途。",
      "keywords": ["button"],
      "docsPaths": ["src/components/Button/README.md"],
      "examplePaths": ["src/components/Button/demo.tsx"],
      "importName": "Button",
      "tag": "Button",
      "path": "src/components/Button"
    }
  ]
}

package.json:
\`\`\`json
${packageJson || "{}"}
\`\`\`

README 摘要:
\`\`\`md
${readme || "(none)"}
\`\`\`

确定性发现的 package 候选:
\`\`\`json
${discoveredPackage}
\`\`\`

确定性发现的组件清单:
\`\`\`text
${discoveredComponents}
\`\`\`

代码树（辅助上下文，有界；不作为完整组件清单）:
\`\`\`text
${tree.join("\n")}
\`\`\`
`.trim();
};

export { buildDescriptorPrompt };
