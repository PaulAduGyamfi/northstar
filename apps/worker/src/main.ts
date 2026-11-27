import { fileURLToPath } from "node:url";
import { connectDb, loadDbConfig } from "@northstar/db";
import { NativeConnection, Worker } from "@temporalio/worker";
import { loadWorkerConfig } from "./config.js";
import { workerOptions } from "./pools.js";
import { APPLY_BROWSER_QUEUE, PIPELINE_QUEUE } from "./queues.js";
import { workerActivities } from "./wiring.js";

// The worker process (NS-225, ADR-0001): connects to Temporal and runs one Worker per domain
// queue (RES-001). `pipeline` runs the workflows and the database activities; `apply-browser`
// runs the Apply Gateway's submit activity, only while WORKER_APPLY_BROWSER is on. A thin shell:
// the settings (config.ts), the bound activities (wiring.ts) and the pool limits (pools.ts) are
// tested without a server. Temporal's Worker stops cleanly on SIGINT and SIGTERM.

// The workflow bundle's entry: the worker bundles it for Temporal's sandbox at start.
const WORKFLOWS = fileURLToPath(new URL("./workflows/index.js", import.meta.url));

export async function main(env: Record<string, string | undefined>): Promise<void> {
  const config = loadWorkerConfig(env);
  const { db, close } = connectDb(loadDbConfig(env));
  const activities = workerActivities(db, config);
  const connection = await NativeConnection.connect({ address: config.temporalAddress });
  try {
    const shared = { connection, namespace: config.temporalNamespace };
    const workers = [
      await Worker.create({
        ...shared,
        ...workerOptions(PIPELINE_QUEUE, config.pools),
        workflowsPath: WORKFLOWS,
        activities: activities.pipeline,
      }),
    ];
    if (activities.applyBrowser !== null) {
      workers.push(
        await Worker.create({
          ...shared,
          ...workerOptions(APPLY_BROWSER_QUEUE, config.pools),
          activities: activities.applyBrowser,
        }),
      );
    }
    // One line, with no setting values: which pools run.
    console.log(
      JSON.stringify({
        msg: "worker started",
        queues: workers.map((w) => w.options.taskQueue),
        applyBrowser: activities.applyBrowser !== null,
      }),
    );
    // Runs until a signal stops them; one failing stops the process, so a pool is never silently
    // down while the other runs.
    await Promise.all(workers.map((w) => w.run()));
  } finally {
    await connection.close();
    await close();
  }
}
