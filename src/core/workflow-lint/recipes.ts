import type { Box } from '../utils.js'
import type { ContainerLayoutRecipe, WorkflowLintIssue } from './types.js'

type PreferredRecipeKind = 'cell-row' | 'repeat-group'

const intersectionArea = (left: Box, right: Box) => {
  const overlapX = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x),
  )
  const overlapY = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
  )
  return overlapX * overlapY
}

const overlapRatio = (left: Box, right: Box) => {
  const overlap = intersectionArea(left, right)
  if (!overlap) return 0
  const leftArea = Math.max(1, left.width * left.height)
  const rightArea = Math.max(1, right.width * right.height)
  return overlap / Math.min(leftArea, rightArea)
}

const areaSimilarity = (left: Box, right: Box) => {
  const leftArea = Math.max(1, left.width * left.height)
  const rightArea = Math.max(1, right.width * right.height)
  return Math.min(leftArea, rightArea) / Math.max(leftArea, rightArea)
}

const preferredRecipeKindsForIssue = (
  kind: WorkflowLintIssue['kind'],
): readonly ContainerLayoutRecipe['kind'][] => {
  switch (kind) {
    case 'short-token-row-nested-cells':
    case 'flat-root-structure':
      return ['repeat-group', 'shell-candidate'] as const
    case 'fullwidth-punctuation':
    case 'nested-cell-text':
      return ['cell-row', 'repeat-group'] as const satisfies readonly PreferredRecipeKind[]
    default:
      return [] as const satisfies readonly PreferredRecipeKind[]
  }
}

export const attachRecommendedRecipes = ({
  issues,
  recipes,
}: {
  issues: WorkflowLintIssue[]
  recipes: ContainerLayoutRecipe[]
}) =>
  issues.map((issue) => {
    const preferredKinds = preferredRecipeKindsForIssue(issue.kind)
    const preferredKindNames: readonly string[] = preferredKinds
    const candidates = recipes
      .map((recipe) => {
        const overlaps = issue.region
          ? recipe.targets.map((target) => ({
              areaSimilarity: areaSimilarity(issue.region!, target.box),
              overlap: overlapRatio(issue.region!, target.box),
            }))
          : []
        const bestOverlap = overlaps.length
          ? Math.max(...overlaps.map((item) => item.overlap))
          : 0
        const bestAreaSimilarity = overlaps.length
          ? Math.max(...overlaps.map((item) => item.areaSimilarity))
          : 0
        const kindPriority = preferredKindNames.indexOf(recipe.kind)
        return {
          bestAreaSimilarity,
          bestOverlap,
          kindPriority: kindPriority >= 0 ? kindPriority : preferredKindNames.length + 1,
          recipe,
          sizeAwareScore: bestOverlap * bestAreaSimilarity,
        }
      })
      .filter(
        (candidate) =>
          (candidate.bestOverlap >= 0.2 && candidate.bestAreaSimilarity >= 0.015) ||
          preferredKindNames.includes(candidate.recipe.kind),
      )
      .sort(
        (left, right) =>
          left.kindPriority - right.kindPriority ||
          right.sizeAwareScore - left.sizeAwareScore ||
          right.bestAreaSimilarity - left.bestAreaSimilarity ||
          right.bestOverlap - left.bestOverlap ||
          left.recipe.id.localeCompare(right.recipe.id),
      )

    const recommendedRecipeIds = candidates.slice(0, 3).map((candidate) => candidate.recipe.id)
    if (!recommendedRecipeIds.length) return issue
    return {
      ...issue,
      recommendedRecipeIds,
    }
  })
