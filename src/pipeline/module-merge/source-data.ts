import { isRecord } from "../../core/type-guards.js";
import type { ModuleMergeResolvedModule } from "./types.js";

/**
 * Framework source-data contract (Vue/React).
 *
 * Each module may write a `source-data.json` containing an arbitrary JSON
 * object literal (e.g. `{ "items": [...], "title": "..." }`). The merge pipeline
 * collects every module's source-data into a single page-scoped `sourceData`
 * constant keyed by module id:
 *
 *   const sourceData = {
 *     "module-03": { "items": [...] },
 *     "module-04": { "titles": [...] },
 *   };
 *
 * Source fragments reference their own data via `sourceData["<moduleId>"].xxx`.
 * This keeps every module self-contained and avoids top-level key collisions.
 *
 * The previous `bindings[]` array schema is no longer supported: agents never
 * wrote it in practice, and the simpler whole-object contract removes a class
 * of "variable not declared" runtime failures.
 */
type FrameworkSourceDataPlan = {
  /**
   * Statement that declares the shared `sourceData` constant. Identical for
   * Vue (`<script setup>`) and React (function body). Empty string when no
   * module contributed data, so the rendered entry stays valid.
   */
  statement: string;
};

const jsLiteral = (value: unknown) =>
  JSON.stringify(value ?? null, null, 2)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

const isPlainDataObject = (value: unknown): value is Record<string, unknown> =>
  isRecord(value);

/**
 * Build the page-scoped `sourceData` declaration from each module's
 * `source-data.json`. Modules without source-data (or with non-object content)
 * are silently omitted. The result is identical for Vue and React: both
 * frameworks get `const sourceData = {...};`.
 *
 * NOTE: source-data.json is keyed by the host under the module id; agents must
 * NOT pre-nest their data under the module id (that double-nests and yields
 * runtime `undefined`). We surface such mistakes via the framework build /
 * render health check rather than silently unwrapping them, so the agent's
 * in-turn framework verify can catch and fix the contract violation.
 */
const createFrameworkSourceDataPlan = (
  modules: ModuleMergeResolvedModule[],
): FrameworkSourceDataPlan => {
  const collected: Record<string, unknown> = {};
  for (const module of modules) {
    const raw = module.sourceData;
    if (!raw || !isPlainDataObject(raw)) continue;
    if (Object.keys(raw).length === 0) continue;
    collected[module.id] = raw;
  }
  if (Object.keys(collected).length === 0) {
    return { statement: "" };
  }
  return {
    statement: `const sourceData = ${jsLiteral(collected)};`,
  };
};

export { createFrameworkSourceDataPlan };
export type { FrameworkSourceDataPlan };
