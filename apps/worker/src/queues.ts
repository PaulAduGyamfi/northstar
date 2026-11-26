// Task queues, one per domain (RES-001, .claude/rules/worker.md): a crash or overload in one
// pool (the browsers in apply-browser) can't starve another. Each domain's work stays on its own
// queue. Only the two this ticket uses are named; the others arrive with their workflows.
export const PIPELINE_QUEUE = "pipeline";
export const APPLY_BROWSER_QUEUE = "apply-browser";
