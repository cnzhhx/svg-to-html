import { escapeRegExp } from "./utils.js";

const stripCssComments = (css: string) => {
  let output = "";
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < css.length; index += 1) {
    const char = css[index];
    const next = css[index + 1];
    const previous = css[index - 1];

    if (quote) {
      output += char;
      if (char === quote && previous !== "\\") quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      output += char;
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (index < css.length) {
        if (css[index] === "*" && css[index + 1] === "/") {
          index += 1;
          break;
        }
        index += 1;
      }
      output += " ";
      continue;
    }

    output += char;
  }

  return output;
};

const splitSelectorList = (selectors: string) => {
  const result: string[] = [];
  let current = "";
  let bracketDepth = 0;
  let parenDepth = 0;
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < selectors.length; index += 1) {
    const char = selectors[index];
    const previous = selectors[index - 1];

    if (quote) {
      current += char;
      if (char === quote && previous !== "\\") quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === "[") bracketDepth += 1;
    if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    if (char === "(") parenDepth += 1;
    if (char === ")") parenDepth = Math.max(0, parenDepth - 1);

    if (char === "," && bracketDepth === 0 && parenDepth === 0) {
      result.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) result.push(current.trim());
  return result;
};

const scopeSingleSelector = (selector: string, scopeSelector: string) => {
  const trimmed = selector.trim();
  if (!trimmed) return trimmed;
  if (trimmed.includes(scopeSelector)) return trimmed;
  if (trimmed === ":root" || /^(html|body)(?:$|[.#:[\s>+~])/.test(trimmed)) {
    return trimmed.replace(/^(html|body|:root)/, scopeSelector);
  }
  if (trimmed.startsWith(":host")) {
    return trimmed.replace(/^:host/, scopeSelector);
  }
  return `${scopeSelector} ${trimmed}`;
};

const scopeSelectorList = (selectors: string, scopeSelector: string) =>
  splitSelectorList(selectors)
    .map((selector) => scopeSingleSelector(selector, scopeSelector))
    .join(", ");

const collectKeyframeNames = (css: string, keyframePrefix: string) => {
  const names = new Map<string, string>();
  const pattern = /@(?:-\w+-)?keyframes\s+([_a-zA-Z][\w-]*)/g;
  for (const match of css.matchAll(pattern)) {
    const name = match[1];
    if (!name || name.startsWith(keyframePrefix)) continue;
    names.set(name, `${keyframePrefix}${name}`);
  }
  return names;
};

const replaceAnimationNames = (
  value: string,
  keyframes: Map<string, string>,
) => {
  let output = value;
  for (const [name, scopedName] of keyframes) {
    output = output.replace(
      new RegExp(`(^|[^\\w-])(${escapeRegExp(name)})(?![\\w-])`, "g"),
      `$1${scopedName}`,
    );
  }
  return output;
};

const scopeKeyframes = (css: string, keyframePrefix: string) => {
  const keyframes = collectKeyframeNames(css, keyframePrefix);
  if (!keyframes.size) return css;

  let output = css.replace(
    /(@(?:-\w+-)?keyframes\s+)([_a-zA-Z][\w-]*)/g,
    (fullMatch: string, prelude: string, name: string) =>
      keyframes.has(name) ? `${prelude}${keyframes.get(name)}` : fullMatch,
  );

  output = output.replace(
    /(\banimation(?:-name)?\s*:\s*)([^;{}]+)/g,
    (_fullMatch: string, prelude: string, value: string) =>
      `${prelude}${replaceAnimationNames(value, keyframes)}`,
  );

  return output;
};

const findMatchingBrace = (css: string, openIndex: number) => {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let inComment = false;

  for (let index = openIndex; index < css.length; index += 1) {
    const char = css[index];
    const next = css[index + 1];
    const previous = css[index - 1];

    if (inComment) {
      if (char === "*" && next === "/") {
        inComment = false;
        index += 1;
      }
      continue;
    }

    if (quote) {
      if (char === quote && previous !== "\\") quote = null;
      continue;
    }

    if (char === "/" && next === "*") {
      inComment = true;
      index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  throw new Error('Unable to scope CSS: unmatched "{"');
};

const scopeCss = (
  css: string,
  scopeSelector: string,
  keyframePrefix?: string,
): string => {
  const uncommentedCss = stripCssComments(css);
  const sourceCss = keyframePrefix
    ? scopeKeyframes(uncommentedCss, keyframePrefix)
    : uncommentedCss;
  let output = "";
  let cursor = 0;

  while (cursor < sourceCss.length) {
    const openIndex = sourceCss.indexOf("{", cursor);
    if (openIndex < 0) {
      output += sourceCss.slice(cursor);
      break;
    }

    const prelude = sourceCss.slice(cursor, openIndex);
    const trimmedPrelude = prelude.trim();
    const closeIndex = findMatchingBrace(sourceCss, openIndex);
    const body = sourceCss.slice(openIndex + 1, closeIndex);
    const trailing = sourceCss.slice(closeIndex, closeIndex + 1);
    const lowerPrelude = trimmedPrelude.toLowerCase();

    if (!trimmedPrelude) {
      output += `${prelude}{${body}${trailing}`;
    } else if (
      lowerPrelude.startsWith("@media") ||
      lowerPrelude.startsWith("@supports") ||
      lowerPrelude.startsWith("@container") ||
      lowerPrelude.startsWith("@layer")
    ) {
      output += `${prelude}{${scopeCss(body, scopeSelector)}}`;
    } else if (trimmedPrelude.startsWith("@")) {
      output += `${prelude}{${body}}`;
    } else {
      const prefix = prelude.slice(0, prelude.indexOf(trimmedPrelude));
      output += `${prefix}${scopeSelectorList(trimmedPrelude, scopeSelector)}{${body}}`;
    }

    cursor = closeIndex + 1;
  }

  return output;
};

export { scopeCss };
