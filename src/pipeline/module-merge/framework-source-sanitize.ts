/**
 * Defensive sanitization for the final framework source file
 * (the merged `设计方案.tsx` / `设计方案.vue`) written by `mergeSourceEntry`.
 *
 * Why this exists: the merged React source is the only JSX-bearing file in
 * the pipeline whose host-generated import block does NOT include
 * `import React from "react"` (see `createReactSourceEntry`). The Vite react()
 * plugin uses the classic JSX runtime, so `React` must be in scope at runtime.
 * When a module fragment references `React.Fragment` / `React.createElement` /
 * `React.useState` / ... without importing React, Vite builds successfully but
 * the bundle throws `ReferenceError: React is not defined` in the browser and
 * the framework mount stays empty.
 *
 * This sanitizer is the engineering backstop. It rewrites known `React.<API>`
 * namespace references to named imports and, when only plain JSX (which the
 * classic runtime resolves via the `React` binding) is present, injects a
 * default React import — matching what `createReactEntry` (entry main.tsx) and
 * `buildReactModuleEntry` (module-local verify Module.tsx) already do.
 *
 * Vue is a no-op here: `<script setup>` is host-generated and only ever
 * contains the `sourceData` constant (no Vue API
 * calls), and module fragments are normalized to bare template bodies, so
 * there is no analogous runtime ReferenceError surface. Diagnostic warnings
 * for unusual Vue/React fragments live in `module-output-policy`.
 */

/** React APIs the model may write as `React.<name>` that we can safely rewrite. */
const REACT_NAMED_IMPORTABLE_APIS = [
  // Element / component helpers
  "Fragment",
  "createElement",
  "cloneElement",
  "isValidElement",
  "memo",
  "forwardRef",
  "lazy",
  "Suspense",
  "StrictMode",
  "Children",
  // Hooks
  "useState",
  "useEffect",
  "useRef",
  "useMemo",
  "useCallback",
  "useContext",
  "useReducer",
  "useLayoutEffect",
  "useImperativeHandle",
  "useDebugValue",
  "useId",
  "useSyncExternalStore",
] as const;

const REACT_NAMED_API_PATTERN = new RegExp(
  `\\bReact\\.(${REACT_NAMED_IMPORTABLE_APIS.join("|")})\\b`,
  "g",
);

/** Matches any other `React.<member>` reference we don't know how to rewrite. */
const REACT_UNKNOWN_NAMESPACE_PATTERN = /\bReact\.([A-Za-z_$][\w$]*)/g;

/** Matches an existing `react` import so we don't inject a duplicate. */
const EXISTING_REACT_IMPORT_PATTERN = /^\s*import\s+(?:React\b|type\s+\{|[\w{},\s]+\bfrom\s*["']react["'])/m;

/**
 * Collect which known React APIs are referenced via the `React.` namespace,
 * and rewrite those references to bare names. Returns the rewritten content
 * plus the set of named APIs to import.
 */
const rewriteKnownReactNamespace = (content: string) => {
  const used = new Set<string>();
  const rewritten = content.replace(
    REACT_NAMED_API_PATTERN,
    (_match, api: string) => {
      used.add(api);
      return api;
    },
  );
  return { rewritten, used };
};

const buildNamedImportLine = (apis: string[]) =>
  `import { ${apis.join(", ")} } from "react";`;

const hasLeadingReactImport = (content: string) =>
  EXISTING_REACT_IMPORT_PATTERN.test(content);

/**
 * Prepend an import line at the very top of the source (before any host
 * import). Done here instead of injecting into `createReactSourceEntry`'s
 * import array so the fix is centralized in one place and order-independent.
 */
const prependImport = (content: string, importLine: string) => {
  if (hasLeadingReactImport(content)) return content;
  return `${importLine}\n${content.replace(/^\n+/, "")}`;
};

const sanitizeReactSource = (content: string) => {
  const { rewritten, used } = rewriteKnownReactNamespace(content);
  const knownApis = [...used].sort();

  // Unknown `React.<member>` references can't be safely rewritten to a named
  // import; fall back to a default React import so the original namespace form
  // resolves at runtime.
  const hasUnknownNamespace = REACT_UNKNOWN_NAMESPACE_PATTERN.test(rewritten);

  if (knownApis.length > 0) {
    return prependImport(rewritten, buildNamedImportLine(knownApis));
  }

  if (hasUnknownNamespace) {
    return prependImport(rewritten, `import React from "react";`);
  }

  // No `React.` namespace reference at all. The classic JSX runtime still
  // needs the `React` binding for any JSX literal (`<div>`, `<>`, `<Comp/>`),
  // and this file is the only JSX-bearing host output that doesn't already
  // inject the default import. Inject it unconditionally to match the entry
  // main.tsx and the module-local verify Module.tsx behavior.
  return prependImport(rewritten, `import React from "react";`);
};

/**
 * Sanitize a merged framework source file in-place (pure function: returns the
 * (possibly modified) content). Vue is currently a no-op kept for interface
 * symmetry; defensive diagnostics for Vue live in `module-output-policy`.
 */
const sanitizeFrameworkSourceEntry = (
  content: string,
  format: "vue" | "react",
) => (format === "react" ? sanitizeReactSource(content) : content);

export { sanitizeFrameworkSourceEntry };
