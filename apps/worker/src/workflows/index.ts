// The workflows a worker registers (its workflowsPath). Only workflow code and plain data may be
// imported from here: Temporal bundles it into the deterministic sandbox.
export { approvalSignal, submissionWorkflow, withdrawnSignal } from "./submission.js";
