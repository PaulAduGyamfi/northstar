import { proxyActivities } from "@temporalio/workflow";

// Test-only workflow (NS-224, excluded from the build): it runs one activity so a test can use
// the worker's own client (Context.current().client), the way wiring.ts binds the relay's
// TemporalPort. Its activity runs on the same queue as this workflow.

export type ProbeActivities = {
  probeNotFound(workflowId: string): Promise<{ delivered: boolean; waiting: boolean }>;
};

const { probeNotFound } = proxyActivities<ProbeActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 1 },
});

export async function notFoundProbeWorkflow(
  workflowId: string,
): Promise<{ delivered: boolean; waiting: boolean }> {
  return probeNotFound(workflowId);
}
