import type { Box } from '../utils.js'
import type { RebuildRecipe } from '../container-layout/types.js'

export type WorkflowLintIssue = {
  kind:
    | 'flat-root-structure'
    | 'css-hand-drawn-icon'
    | 'full-page-shell-fallback'
    | 'fullwidth-punctuation'
    | 'hidden-editable-text'
    | 'nested-cell-text'
    | 'short-token-row-nested-cells'
    | 'static-shell-rasterized'
    | 'text-bitmap-crop'
    | 'text-bearing-svg-asset'
  recommendedRecipeIds?: string[]
  region?: Box
  selectors: string[]
  severity: 'error' | 'warning'
  summary: string
}

export type WorkflowLintReport = {
  criticalIssueCount: number
  designName: string
  issueCount: number
  issues: WorkflowLintIssue[]
  passed: boolean
}

export type ContainerLayoutRecipe = Pick<RebuildRecipe, 'id' | 'kind' | 'targets'>
