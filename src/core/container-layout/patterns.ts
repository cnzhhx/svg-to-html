import type { Box } from "../utils.js";
import { areaOf, bottomOf, isSimilar, rightOf } from "./geometry.js";
import type {
  ContainerRecord,
  PatternHint,
  RebuildRecipe,
  RepeatedGroupRecord,
} from "./types.js";

export const buildRepeatedGroups = (containers: ContainerRecord[]) => {
  const childrenByParent = new Map<string, ContainerRecord[]>();

  containers.forEach((container) => {
    if (!container.parentContainerId) return;
    const bucket = childrenByParent.get(container.parentContainerId) ?? [];
    bucket.push(container);
    childrenByParent.set(container.parentContainerId, bucket);
  });

  const repeatedGroups: RepeatedGroupRecord[] = [];

  childrenByParent.forEach((siblings, parentContainerId) => {
    if (siblings.length < 2) return;

    const sorted = [...siblings].sort(
      (left, right) => left.box.y - right.box.y || left.box.x - right.box.x,
    );
    const groups = new Map<string, ContainerRecord[]>();

    sorted.forEach((container) => {
      const signature = [
        container.kind,
        container.tag,
        container.directMemberNodePaths.length,
      ].join("|");
      const bucket = groups.get(signature) ?? [];
      bucket.push(container);
      groups.set(signature, bucket);
    });

    groups.forEach((groupSiblings, signature) => {
      if (groupSiblings.length < 2) return;
      const first = groupSiblings[0];
      if (!first) return;

      const shareYBand = groupSiblings.every(
        (item) => Math.abs(item.box.y - first.box.y) <= 8,
      );
      const shareXBand = groupSiblings.every(
        (item) => Math.abs(item.box.x - first.box.x) <= 8,
      );
      const similarWidths = groupSiblings.every((item) =>
        isSimilar(item.box.width, first.box.width, 0.18),
      );

      const alignment =
        shareYBand && similarWidths ? "row" : shareXBand ? "column" : null;
      if (!alignment) return;

      const ordered = [...groupSiblings].sort((left, right) =>
        alignment === "row"
          ? left.box.x - right.box.x
          : left.box.y - right.box.y,
      );
      const gaps = ordered.slice(1).map((item, index) => {
        const previous = ordered[index];
        if (!previous) return 0;
        return alignment === "row"
          ? item.box.x - rightOf(previous.box)
          : item.box.y - bottomOf(previous.box);
      });
      const averageGapPx =
        gaps.length > 0
          ? Number(
              (
                gaps.reduce((sum, value) => sum + value, 0) / gaps.length
              ).toFixed(2),
            )
          : 0;
      if (averageGapPx < -1) return;

      repeatedGroups.push({
        alignment,
        containerIds: ordered.map((item) => item.id),
        gapPx: averageGapPx,
        parentContainerId,
        signature,
      });
    });
  });

  return repeatedGroups;
};

const similarSize = (left: Box, right: Box) => {
  const widthTolerance = Math.max(6, Math.min(left.width, right.width) * 0.12);
  const heightTolerance = Math.max(
    6,
    Math.min(left.height, right.height) * 0.12,
  );
  return (
    Math.abs(left.width - right.width) <= widthTolerance &&
    Math.abs(left.height - right.height) <= heightTolerance
  );
};

const nearlySameRow = (left: Box, right: Box) =>
  Math.abs(left.y + left.height / 2 - (right.y + right.height / 2)) <=
  Math.max(8, Math.min(left.height, right.height) * 0.45);

const toRecipeId = (kind: PatternHint["kind"], containerIds: string[]) =>
  `${kind}:${containerIds.join(",")}`;

export const detectRepeatGroupPatterns = (
  repeatedGroups: RepeatedGroupRecord[],
) =>
  repeatedGroups
    .filter((group) => group.containerIds.length >= 2)
    .map<PatternHint>((group) => ({
      containerIds: group.containerIds,
      kind: "repeat-group",
      recipeId: toRecipeId("repeat-group", group.containerIds),
      summary:
        "检测到同层重复模块。这里更像重复卡片/列表项的模板结构，优先抽成统一 item 容器，静态壳层能整块提取就不要拆成零散装饰。",
    }));

export const detectCellRows = (containers: ContainerRecord[]) => {
  const candidates = containers.filter((container) => {
    const ratio = container.box.width / Math.max(1, container.box.height);
    return (
      container.kind !== "root" &&
      container.box.width >= 18 &&
      container.box.width <= 64 &&
      container.box.height >= 18 &&
      container.box.height <= 64 &&
      ratio >= 0.65 &&
      ratio <= 1.45
    );
  });

  const groups = new Map<string, ContainerRecord[]>();

  candidates.forEach((container) => {
    const key = `${container.parentContainerId ?? "root"}:${container.depth}:${Math.round((container.box.y + container.box.height / 2) / 8)}`;
    const current = groups.get(key) ?? [];
    current.push(container);
    groups.set(key, current);
  });

  const patterns: PatternHint[] = [];

  groups.forEach((items) => {
    const sorted = [...items].sort((left, right) => left.box.x - right.box.x);
    const row: ContainerRecord[] = [];

    sorted.forEach((item) => {
      if (!row.length) {
        row.push(item);
        return;
      }

      const seed = row[0];
      const prev = row[row.length - 1];
      if (!seed || !prev) return;
      const gap = item.box.x - (prev.box.x + prev.box.width);
      if (!similarSize(seed.box, item.box)) return;
      if (!nearlySameRow(seed.box, item.box)) return;
      if (gap > Math.max(40, item.box.width * 2.2)) return;
      row.push(item);
    });

    if (row.length < 3) return;

    patterns.push({
      containerIds: row.map((item) => item.id),
      kind: "cell-row",
      recipeId: toRecipeId(
        "cell-row",
        row.map((item) => item.id),
      ),
      summary:
        "检测到一整排近似等宽的小 cell 壳层。这通常是紧凑短 token 区，不要在每个 cell 里再留一层手工偏移 label；优先还原为完整壳层 + 直接文本碎片，或压平后的单节点 cell。",
    });
  });

  return patterns;
};

export const detectShellCandidates = ({
  containers,
  designArea,
  repeatedGroups,
}: {
  containers: ContainerRecord[];
  designArea: number;
  repeatedGroups: RepeatedGroupRecord[];
}) => {
  const repeatedIds = new Set(
    repeatedGroups.flatMap((group) => group.containerIds),
  );

  return containers
    .filter((container) => {
      if (container.kind === "root") return false;
      if (container.box.width < 120 || container.box.height < 60) return false;
      if (areaOf(container.box) < designArea * 0.035) return false;
      return (
        container.descendantCount >= 6 ||
        container.childContainerIds.length >= 1 ||
        repeatedIds.has(container.id)
      );
    })
    .sort((left, right) => areaOf(right.box) - areaOf(left.box))
    .slice(0, 8)
    .map<PatternHint>((container) => ({
      containerIds: [container.id],
      kind: "shell-candidate",
      recipeId: toRecipeId("shell-candidate", [container.id]),
      summary: repeatedIds.has(container.id)
        ? "这是重复模块里的复杂容器候选。若该区域主要承担静态装饰职责，优先用统一模板或模块局部小型资产处理稳定细节，不要把重复项拆成互不相关的散点。"
        : "这是复杂容器候选。若内部主要是边框、纹理、角标、mask/clipPath 等静态细节，优先保持统一父容器和局部资产边界，不要拆成若干近似 DIV。",
    }));
};

export const createRebuildRecipes = ({
  containers,
  patterns,
}: {
  containers: ContainerRecord[];
  patterns: PatternHint[];
}): RebuildRecipe[] => {
  const byId = new Map(
    containers.map((container) => [container.id, container] as const),
  );

  return patterns.map<RebuildRecipe>((pattern) => {
    const targets = pattern.containerIds
      .map((containerId) => byId.get(containerId))
      .filter((container): container is ContainerRecord => Boolean(container))
      .map((container) => ({
        box: container.box,
        containerId: container.id,
      }));

    if (pattern.kind === "cell-row") {
      return {
        applyWhen:
          "同一行内出现 3 个及以上近似等宽的小 cell，通常对应紧凑数字、单位、标点或短状态片段。",
        forbiddenStructure: [
          "禁止 `div.cell > span { position:absolute; left/top... }` 这种内层 label 偏移结构。",
          "禁止继续使用全角 `：`、`；` 这类标点去对数字 token。",
          "禁止把整行 diff 平摊成每个 token 的 `margin-left` 微调。",
        ],
        id: pattern.recipeId,
        kind: pattern.kind,
        preferredStructure: [
          "优先把整排视为一个 token-row root；复杂背景细节放在同一个 row/root 边界内处理。",
          "文本 token 直接作为 token-row root 的子节点按 SVG 真实文本盒绝对定位，不要再嵌进每个小黑格里手调 offset。",
          "如果必须保留单个 cell，也只能压平成“单节点 cell”，由 cell 根节点自己承担背景和文本排布。",
          "标点默认使用半角 `:`；数字、单位、冒号分别作为独立文本碎片校验。",
        ],
        targets,
        title: "Token Row Recipe",
        validationFocus: [
          "数字 token 的 `Δy` 应接近 0；若仍整体下沉，说明 top compensation 还没真正落回 HTML。",
          "若 `Δx` 仍大，优先检查锚点/结构，不要继续抠字号。",
        ],
      };
    }

    if (pattern.kind === "repeat-group") {
      return {
        applyWhen:
          "同层出现 2 个及以上尺寸和排布节奏稳定的大模块，通常对应重复卡片、列表项、矩阵项。",
        forbiddenStructure: [
          "禁止把每张卡完全手写成独立散点结构，导致同类问题无法一次修复。",
          "禁止只抽纯色底板，再在每张卡里重复手搓静态装饰。",
        ],
        id: pattern.recipeId,
        kind: pattern.kind,
        preferredStructure: [
          "先建立统一的 item/article 模板，再按同一结构重复渲染。",
          "模板内部优先保持一致的壳层、图片区、文本区分工；文本回写必须按每张卡自己的 SVG 盒分别做。",
          "若静态细节复杂，优先在模板内使用明确边界的模块局部小型资产或 CSS 结构复用，不要改成整张卡大图。",
        ],
        targets,
        title: "Repeat Item Recipe",
        validationFocus: [
          "重复模块的关键偏差应能通过一次模板修改一起收敛。",
          "不要只在首张卡上做字体/布局反算后复制到其他卡。",
        ],
      };
    }

    return {
      applyWhen:
        "某个大容器主要承担边框、纹理、角标、mask/clipPath、光效等静态职责，手写 HTML/CSS 代价高且容易近似失真。",
      forbiddenStructure: [
        "禁止只留下底板，再把边框、角标、纹理、细线拆成多层近似 DIV。",
        "禁止抽壳层后又在 HTML 里重复叠一遍同类静态装饰。",
      ],
      id: pattern.recipeId,
      kind: pattern.kind,
      preferredStructure: [
        "优先建立完整父容器，复杂 gradient/mask/clipPath/filter 细节可生成边界清晰的模块局部小型资产。",
        "动态文本、数字、状态标签仍应独立放置，不要被烘焙进可变内容层。",
        "重复模块中的复杂静态细节优先做成统一模板或统一局部资产，避免每张卡重新近似。",
      ],
      targets,
      title: "Complex Container Recipe",
      validationFocus: [
        "HTML 层不应再出现重复静态装饰导致的透明度或位置重影。",
      ],
    };
  });
};
