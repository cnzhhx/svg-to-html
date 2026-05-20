const LAYOUT_BOX_GATE_FAILURE_MESSAGE =
  'Layout box gate failed: text-layout feedback loop is not active. Check box-report.md and add tracked blocks before treating verify as passed.'
const WORKFLOW_LINT_GATE_FAILURE_MESSAGE =
  'Workflow lint gate failed: critical structural/text-token/text-fallback issues remain. Check workflow-lint.md before treating verify as passed.'
const DIFF_RATIO_GATE_FAILURE_MESSAGE =
  'Diff ratio gate failed: rendered HTML still differs from SVG above the configured threshold. Check verify-report.md before treating verify as passed.'
const FINAL_OUTPUT_POLICY_GATE_FAILURE_MESSAGE =
  'Final output policy gate failed: forbidden SVG fallback, hidden semantic DOM, missing local assets, or text-bearing/scrubbed image assets remain. Check final-output-policy.md before treating verify as passed.'
const MODULE_REGION_DIFF_GATE_FAILURE_MESSAGE =
  'Module region diff gate failed: at least one module region is above the configured threshold. Check verify-report.md before treating verify as passed.'

export {
  DIFF_RATIO_GATE_FAILURE_MESSAGE,
  FINAL_OUTPUT_POLICY_GATE_FAILURE_MESSAGE,
  LAYOUT_BOX_GATE_FAILURE_MESSAGE,
  MODULE_REGION_DIFF_GATE_FAILURE_MESSAGE,
  WORKFLOW_LINT_GATE_FAILURE_MESSAGE,
}
