import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { connectDb, loadDbConfig, recordWorkerHeartbeat, soleCandidate } from "@northstar/db";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { ensureSignalRelay, ensureStaleSweep, temporalPort } from "./client.js";
import { loadWorkerConfig } from "./config.js";
import { startHeartbeats } from "./heartbeat.js";
import { workerOptions } from "./pools.js";
import { APPLY_BROWSER_QUEUE, PIPELINE_QUEUE } from "./queues.js";
import { runPools, stopPools } from "./run-pools.js";
import { workerActivities } from "./wiring.js";

// The worker process (NS-225, ADR-0001): connects to Temporal and runs one Worker per domain
// queue (RES-001). `pipeline` runs the workflows and the database activities; `apply-browser`
// runs the Apply Gateway's submit activity, only while WORKER_APPLY_BROWSER is on. A thin shell:
// the settings (config.ts), the bound activities (wiring.ts), the pool limits (pools.ts) and
// running and stopping the pools together (run-pools.ts) are tested without a server. Temporal's
// Worker stops cleanly on SIGINT and SIGTERM.

// The workflow bundle's entry: the worker bundles it for Temporal's sandbox at start.
const WORKFLOWS = fileURLToPath(new URL("./workflows/index.js", import.meta.url));

export async function main(env: Record<string, string | undefined>): Promise<void> {
  const config = loadWorkerConfig(env);
  // A wrong Chromium path would otherwise surface only per submission, after its claim, as a
  // needs_human item each time: fail at start instead.
  if (config.applyBrowser.on) {
    await access(config.applyBrowser.chromiumPath, constants.X_OK).catch(() => {
      throw new Error("WORKER_CHROMIUM_PATH: not an executable file");
    });
  }
  const { db, close } = connectDb(loadDbConfig(env));
  try {
    const activities = workerActivities(db, config);
    // Single tenant for now (Q-02): the one candidate, which soleCandidate creates on an empty
    // database, as the CLIs do.
    const candidateId = await soleCandidate(db);
    // The stale-claim sweep (NS-225 slice 2) and the package decision relay (NS-213 slice 2) run
    // whenever the worker does: each started once, kept when already running.
    const clientConnection = await Connection.connect({ address: config.temporalAddress });
    try {
      const port = temporalPort(
        new Client({ connection: clientConnection, namespace: config.temporalNamespace }),
      );
      await ensureStaleSweep(port, { candidateIds: [candidateId] });
      await ensureSignalRelay(port, { candidateIds: [candidateId] });
    } finally {
      // A close error never hides the sweep's own failure.
      await clientConnection.close().catch(() => {});
    }
    const connection = await NativeConnection.connect({ address: config.temporalAddress });
    // Each Worker holds the connection until it has run and stopped, so the connection closes
    // only after every pool is down; a close error never hides the pools' own failure.
    try {
      const shared = { connection, namespace: config.temporalNamespace };
      const workers: Worker[] = [];
      try {
        workers.push(
          await Worker.create({
            ...shared,
            ...workerOptions(PIPELINE_QUEUE, config.pools),
            workflowsPath: WORKFLOWS,
            activities: activities.pipeline,
          }),
        );
        if (activities.applyBrowser !== null) {
          workers.push(
            await Worker.create({
              ...shared,
              ...workerOptions(APPLY_BROWSER_QUEUE, config.pools),
              activities: activities.applyBrowser,
            }),
          );
        }
      } catch (error) {
        // A later pool couldn't be created: let the ones already made go before closing.
        await stopPools(workers);
        throw error;
      }
      // One line, with no setting values: which pools run.
      console.log(
        JSON.stringify({
          msg: "worker started",
          queues: workers.map((w) => w.options.taskQueue),
          applyBrowser: activities.applyBrowser !== null,
        }),
      );
      // Health shows each pool from these beats (NS-225 slice 3): the browser pool too while it is
      // off, as "turned off", so an earlier run's beat never reads as a pool that died.
      const startedAt = new Date();
      const heartbeats = startHeartbeats(
        [
          { queue: PIPELINE_QUEUE, enabled: true, startedAt },
          { queue: APPLY_BROWSER_QUEUE, enabled: activities.applyBrowser !== null, startedAt },
        ],
        {
          record: (beat) => recordWorkerHeartbeat(db, candidateId, beat),
          every: (fn, ms) => setInterval(fn, ms),
          cancel: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
          onError: (errorClass) =>
            console.error(JSON.stringify({ level: "warn", msg: "heartbeat failed", errorClass })),
        },
      );
      // Runs until a signal stops them. One failing stops the others and its error ends the
      // process, so a pool is never silently down while another runs. While the others shut
      // down the beats go on for a moment: Health reads a pool's process, not its poller.
      try {
        await runPools(workers);
      } finally {
        heartbeats.stop();
      }
    } finally {
      await connection.close().catch(() => {});
    }
  } finally {
    await close();
  }
}
