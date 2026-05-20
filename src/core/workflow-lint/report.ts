import type { WorkflowLintIssue } from './types.js'

export const renderWorkflowLintMarkdown = ({
  criticalIssues,
  designName,
  issues,
  warningIssues,
}: {
  criticalIssues: WorkflowLintIssue[]
  designName: string
  issues: WorkflowLintIssue[]
  warningIssues: WorkflowLintIssue[]
}) =>
  [
    '# Workflow Lint Report',
    '',
    `- design: ${designName}`,
    `- issueCount: ${issues.length}`,
    '',
    '## Critical Issues',
    ...(criticalIssues.length
      ? criticalIssues.map(
          (issue) =>
            `- [${issue.kind}] ${issue.summary} selectors=${issue.selectors.join(', ')}${
              issue.recommendedRecipeIds?.length
                ? ` recipes=${issue.recommendedRecipeIds.join(', ')}`
                : ''
            }`,
        )
      : ['- none']),
    '',
    '## Warnings',
    ...(warningIssues.length
      ? warningIssues.map(
          (issue) =>
            `- [${issue.kind}] ${issue.summary} selectors=${issue.selectors.join(', ')}${
              issue.recommendedRecipeIds?.length
                ? ` recipes=${issue.recommendedRecipeIds.join(', ')}`
                : ''
            }`,
        )
      : ['- none']),
    '',
  ].join('\n')
