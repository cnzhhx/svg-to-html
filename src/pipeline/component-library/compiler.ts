import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { runLlm } from "../llm-client.js";
import {
  discoverComponentLibrarySource,
  mergeDiscoveredComponentLibraryDescriptor,
  type ComponentLibraryDiscovery,
} from "../../core/component-library/discovery.js";
import {
  enrichComponentLibraryDescriptor,
  readJsonFromText,
  validateComponentLibraryDescriptor,
} from "../../core/component-library/descriptor.js";
import {
  normalizeComponentLibraryId,
  resolveComponentLibraryPaths,
} from "../../core/component-library/paths.js";
import {
  writeComponentLibraryDescriptor,
  writeComponentLibraryMeta,
} from "../../core/component-library/registry.js";
import type {
  ComponentLibraryDescriptor,
  ComponentLibraryFramework,
  ComponentLibraryMeta,
  ComponentLibraryRegistryItem,
} from "../../core/component-library/types.js";
import { listComponentLibraries } from "../../core/component-library/registry.js";
import { buildDescriptorPrompt } from "../../prompts/component-library.js";

type CompileComponentLibraryInput = {
  force?: boolean;
  framework: ComponentLibraryFramework;
  sourceDir?: string;
  url?: string;
};

type CompileComponentLibraryResult = {
  descriptor: ComponentLibraryDescriptor;
  descriptorPath: string;
  library: ComponentLibraryRegistryItem;
  sourceDir: string;
};

type CommandResult = {
  stderr: string;
  stdout: string;
};

const execFileAsync = promisify(execFile);

const isExistingCompleteLibrary = (id: string) => {
  const { descriptorPath } = resolveComponentLibraryPaths(id);
  return existsSync(descriptorPath);
};

const copyExcludedDirs = new Set([".git", "node_modules"]);

const runCommand = async (
  command: string,
  args: string[],
  cwd: string,
): Promise<CommandResult> => {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
    });
    return {
      stderr: String(result.stderr ?? ""),
      stdout: String(result.stdout ?? ""),
    };
  } catch (error) {
    const failed = error as {
      code?: number | string;
      stderr?: string | Buffer;
      stdout?: string | Buffer;
    };
    const output = [failed.stdout, failed.stderr]
      .map((value) => String(value ?? ""))
      .join("\n")
      .trim()
      .slice(-4000);
    throw new Error(
      `${command} ${args.join(" ")} failed${failed.code === undefined ? "" : ` with exit code ${failed.code}`}${output ? `\n${output}` : ""}`,
    );
  }
};

const sanitizeSourceLabel = (value: string) =>
  value
    .split(/[/?#]/)
    .filter(Boolean)
    .at(-1)
    ?.replace(/\.git$/i, "") ?? value;

const resolveLibraryId = (input: CompileComponentLibraryInput) =>
  normalizeComponentLibraryId(
    (input.sourceDir ? path.basename(input.sourceDir) : undefined) ??
      (input.url ? sanitizeSourceLabel(input.url) : undefined) ??
      "component-library",
  );

const assertSingleSource = (input: CompileComponentLibraryInput) => {
  const hasSourceDir = Boolean(input.sourceDir?.trim());
  const hasUrl = Boolean(input.url?.trim());
  if (!hasSourceDir && !hasUrl) {
    throw new Error("Provide at least one of --source-dir or --url");
  }
};

const ingestLocalSource = async ({
  sourceDir,
  targetSourceDir,
}: {
  sourceDir: string;
  targetSourceDir: string;
}) => {
  const absoluteSourceDir = path.resolve(sourceDir);
  const sourceStat = await stat(absoluteSourceDir).catch(() => null);
  if (!sourceStat?.isDirectory()) {
    throw new Error(`Component library source dir not found: ${sourceDir}`);
  }
  await cp(absoluteSourceDir, targetSourceDir, {
    filter: (sourcePath) => {
      const relative = path.relative(absoluteSourceDir, sourcePath);
      if (!relative) return true;
      return !relative
        .split(path.sep)
        .some((part) => copyExcludedDirs.has(part));
    },
    force: true,
    recursive: true,
  });
};

const ingestUrlSource = async ({
  targetSourceDir,
  url,
}: {
  targetSourceDir: string;
  url: string;
}) => {
  await runCommand("git", ["clone", "--depth", "1", url, targetSourceDir], process.cwd());
  await rm(path.join(targetSourceDir, ".git"), { force: true, recursive: true });
};


const requestDescriptorFromLlm = async ({
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
  let prompt = await buildDescriptorPrompt({
    discovery,
    framework,
    id,
    sourceDir,
  });
  let lastResponse = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    lastResponse = await runLlm(prompt);
    try {
      const parsed = readJsonFromText(lastResponse);
      return await validateComponentLibraryDescriptor({
        descriptor: parsed,
        expectedFramework: framework,
        expectedId: id,
        sourceDir,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= 3) {
        throw new Error(
          `LLM generated invalid component-library.json after ${attempt} attempts: ${message}`,
        );
      }
      prompt = `
上一次输出的 component-library.json 没有通过校验，请只输出修正后的 JSON 对象。

校验错误：
${message}

上一次输出：
\`\`\`json
${lastResponse}
\`\`\`
`.trim();
    }
  }
  throw new Error("Unable to generate component-library.json");
};

const compileComponentLibrary = async (
  input: CompileComponentLibraryInput,
): Promise<CompileComponentLibraryResult> => {
  assertSingleSource(input);
  const id = resolveLibraryId(input);
  const paths = resolveComponentLibraryPaths(id);
  if (existsSync(paths.dir)) {
    if (input.force || !isExistingCompleteLibrary(id)) {
      await rm(paths.dir, { force: true, recursive: true });
    } else {
      throw new Error(
        `Component library "${id}" already exists. Pass --force to overwrite it.`,
      );
    }
  }
  await mkdir(paths.dir, { recursive: true });

  if (input.sourceDir) {
    await ingestLocalSource({
      sourceDir: input.sourceDir,
      targetSourceDir: paths.sourceDir,
    });
  } else if (input.url) {
    await ingestUrlSource({
      targetSourceDir: paths.sourceDir,
      url: input.url,
    });
  }

  try {
    const discovery = await discoverComponentLibrarySource({
      framework: input.framework,
      sourceDir: paths.sourceDir,
    });
    if (!discovery.components.length) {
      throw new Error(
        "Unable to discover component entries from source. Check that the library has a public index file or a components directory.",
      );
    }
    const generatedDescriptor = await requestDescriptorFromLlm({
      discovery,
      framework: input.framework,
      id,
      sourceDir: paths.sourceDir,
    });
    const mergedDescriptor = await validateComponentLibraryDescriptor({
      descriptor: mergeDiscoveredComponentLibraryDescriptor({
        descriptor: generatedDescriptor,
        discovery,
      }),
      expectedFramework: input.framework,
      expectedId: id,
      sourceDir: paths.sourceDir,
    });
    const descriptor = await enrichComponentLibraryDescriptor({
      descriptor: mergedDescriptor,
      sourceDir: paths.sourceDir,
    });
    await writeComponentLibraryDescriptor({ descriptor, id });

    const now = Date.now();
    const meta: ComponentLibraryMeta = {
      createdAt: now,
      id,
      originalSource: input.sourceDir
        ? path.resolve(input.sourceDir)
        : input.url?.trim(),
      sourceType: input.sourceDir ? "local" : "url",
      updatedAt: now,
    };
    await writeComponentLibraryMeta(id, meta);

    const library = (await listComponentLibraries()).find(
      (item) => item.id === id,
    );
    if (!library) {
      throw new Error(`Compiled component library was not registered: ${id}`);
    }
    return {
      descriptor,
      descriptorPath: paths.descriptorPath,
      library,
      sourceDir: paths.sourceDir,
    };
  } catch (error) {
    if (isExistingCompleteLibrary(id)) {
      // descriptor succeeded before this run, keep the existing one
      throw error;
    }
    await rm(paths.dir, { force: true, recursive: true });
    throw error;
  }
};

export { compileComponentLibrary };
export type { CompileComponentLibraryInput, CompileComponentLibraryResult };
