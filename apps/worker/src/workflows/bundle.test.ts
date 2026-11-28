import { fileURLToPath } from "node:url";
import { bundleWorkflowCode } from "@temporalio/worker";
import { describe, expect, it } from "vitest";

// Temporal's bundler builds workflow code for its deterministic sandbox and refuses Node
// built-ins and other modules a workflow may not use. Bundling here catches such an import
// without a Temporal server.
describe("the workflow bundle", () => {
  it("builds the registered workflows for Temporal's sandbox", async () => {
    const workflowsPath = fileURLToPath(new URL("./index.ts", import.meta.url));
    const { code } = await bundleWorkflowCode({ workflowsPath, logger: quiet });
    expect(code).toContain("submissionWorkflow");
    expect(code).toContain("staleClaimSweepWorkflow");
    // NS-213 slice 2: the decision relay.
    expect(code).toContain("packageSignalRelayWorkflow");
    // NS-193 slice 3: the handoff notifier.
    expect(code).toContain("handoffNotifyWorkflow");
    // NS-280 slice 2: the job pipeline.
    expect(code).toContain("jobPipelineWorkflow");
    // NS-280 slice 3: its starter.
    expect(code).toContain("jobPipelineStarterWorkflow");
  }, 60_000);
});

const noop = () => undefined;
const quiet = { log: noop, trace: noop, debug: noop, info: noop, warn: noop, error: noop };
