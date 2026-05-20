import type {
  SelectorRule,
  TextLayoutBlock,
  TextLayoutConfig,
} from "../../core/text-layout.js";
import type { ModuleMergeResolvedModule } from "./types.js";
import { normalizeRegion, isRecord, isString, asString } from "./utils.js";
import { scopeSelectorList } from "./css.js";

const normalizeSelectorRule = (value: unknown): SelectorRule | null => {
  if (!isRecord(value)) return null;
  const selectors = Array.isArray(value.selectors)
    ? value.selectors.filter(isString)
    : [];
  if (!selectors.length) return null;

  const declarationsSource = isRecord(value.declarations)
    ? value.declarations
    : {};
  const declarations = Object.fromEntries(
    Object.entries(declarationsSource).flatMap(([name, declarationValue]) =>
      isString(declarationValue) || typeof declarationValue === "number"
        ? [[name, String(declarationValue)]]
        : [],
    ),
  );

  return { declarations, selectors };
};

const normalizeTextLayoutBlock = (value: unknown): TextLayoutBlock | null => {
  const rule = normalizeSelectorRule(value);
  if (!rule || !isRecord(value)) return null;
  const id = asString(value.id);
  if (!id) return null;

  return {
    ...rule,
    id,
    region: isRecord(value.region)
      ? normalizeRegion(value.region, `text-layout block ${id}`)
      : undefined,
  };
};

const normalizeTextLayoutConfig = (value: unknown): TextLayoutConfig => {
  const configCandidate =
    isRecord(value) && isRecord(value.textLayout)
      ? value.textLayout
      : isRecord(value) && isRecord(value.config)
        ? value.config
        : value;

  if (Array.isArray(configCandidate)) {
    return {
      blocks: configCandidate.flatMap((item) => {
        const block = normalizeTextLayoutBlock(item);
        return block ? [block] : [];
      }),
      rules: [],
    };
  }

  if (!isRecord(configCandidate)) return { blocks: [], rules: [] };

  const rules = Array.isArray(configCandidate.rules)
    ? configCandidate.rules.flatMap((item) => {
        const rule = normalizeSelectorRule(item);
        return rule ? [rule] : [];
      })
    : [];
  const blocks = Array.isArray(configCandidate.blocks)
    ? configCandidate.blocks.flatMap((item) => {
        const block = normalizeTextLayoutBlock(item);
        return block ? [block] : [];
      })
    : [];

  return { blocks, rules };
};

const scopeTextLayoutRule = (
  rule: SelectorRule,
  scopeSelector: string,
): SelectorRule => ({
  declarations: rule.declarations,
  selectors: rule.selectors.map((selector) =>
    scopeSelectorList(selector, scopeSelector),
  ),
});

const offsetBlockRegion = ({
  block,
  module,
}: {
  block: TextLayoutBlock;
  module: ModuleMergeResolvedModule;
}) => {
  if (!block.region || module.textLayoutCoordinateSpace === "absolute") {
    return block.region;
  }

  return {
    ...block.region,
    x: Number((module.region.x + block.region.x).toFixed(3)),
    y: Number((module.region.y + block.region.y).toFixed(3)),
  };
};

const scopeTextLayoutBlock = (
  block: TextLayoutBlock,
  module: ModuleMergeResolvedModule,
): TextLayoutBlock => {
  const scopeSelector = `[data-module-id="${module.id}"]`;
  const id = block.id.startsWith(`${module.id}:`)
    ? block.id
    : `${module.id}:${block.id}`;

  return {
    declarations: block.declarations,
    id,
    region: offsetBlockRegion({ block, module }),
    selectors: block.selectors.map((selector) =>
      scopeSelectorList(selector, scopeSelector),
    ),
  };
};

const uniquifyTextLayoutBlocks = (blocks: TextLayoutBlock[]) => {
  const seen = new Set<string>();
  return blocks.map((block) => {
    if (!seen.has(block.id)) {
      seen.add(block.id);
      return block;
    }

    let suffix = 2;
    let id = `${block.id}-${suffix}`;
    while (seen.has(id)) {
      suffix += 1;
      id = `${block.id}-${suffix}`;
    }
    seen.add(id);
    return { ...block, id };
  });
};

const mergeTextLayoutConfig = ({
  baseConfig,
  modules,
}: {
  baseConfig: TextLayoutConfig;
  modules: ModuleMergeResolvedModule[];
}): TextLayoutConfig => {
  const moduleRules = modules.flatMap((module) => {
    const scopeSelector = `[data-module-id="${module.id}"]`;
    return module.textLayout.rules.map((rule) =>
      scopeTextLayoutRule(rule, scopeSelector),
    );
  });
  const moduleBlocks = modules.flatMap((module) =>
    (module.textLayout.blocks ?? []).map((block) =>
      scopeTextLayoutBlock(block, module),
    ),
  );

  return {
    blocks: uniquifyTextLayoutBlocks([
      ...(baseConfig.blocks ?? []),
      ...moduleBlocks,
    ]),
    rules: [...(baseConfig.rules ?? []), ...moduleRules],
  };
};

export { mergeTextLayoutConfig, normalizeTextLayoutConfig };
