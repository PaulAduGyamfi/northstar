import { type Db, readDecisionPackage, readStoredFile } from "@northstar/db";
import type { CandidateId } from "@northstar/domain";
import {
  type ApplyPorts,
  type ApplyStep,
  dbPorts,
  dbSweepPorts,
  deferredFormDriver,
  launchFormDriver,
  type SubmitInput,
  submitApplication,
  sweepStaleClaims,
} from "@northstar/gateways";
import { Context } from "@temporalio/activity";
import { type BeatStep, createApplyActivities } from "./activities/apply.js";
import { createEndingActivities } from "./activities/ending.js";
import { createNotifyActivities } from "./activities/notify.js";
import { createRelayActivities, dbReadSignals } from "./activities/relay.js";
import { createSweepActivities } from "./activities/sweep.js";
import { type TemporalPort, temporalPort } from "./client.js";
import type { WorkerConfig } from "./config.js";
import { dbNotifyPorts } from "./notify-ports.js";

// The activities each pool runs, bound to the real write paths (NS-225). Plain code with no
// Temporal connection, so the wiring is tested without a server; main.ts hands these to its
// Workers. Each queue gets only its own activities (RES-001): the pipeline pool never opens a
// browser, and the browser pool exists only while Paul has turned it on.

export type PoolActivities = {
  pipeline: ReturnType<typeof createEndingActivities> &
    ReturnType<typeof createSweepActivities> &
    ReturnType<typeof createRelayActivities> &
    ReturnType<typeof createNotifyActivities>;
  // Null while WORKER_APPLY_BROWSER is off: nothing can be submitted.
  applyBrowser: ReturnType<typeof createApplyActivities> | null;
};

// `launch` is launchFormDriver and `beat` Temporal's activity heartbeat (the step name is its
// only detail, never a value); a test passes fakes so no browser starts. `temporal` is the
// relay's way to Temporal: the worker's own client, from the running activity's context (NS-213
// slice 2), so no second connection.
export function workerActivities(
  db: Db,
  config: Pick<WorkerConfig, "applyBrowser" | "applyLimits" | "push">,
  launch: typeof launchFormDriver = launchFormDriver,
  beat: (step: BeatStep) => void = (step) => Context.current().heartbeat(step),
  temporal: () => TemporalPort = () => temporalPort(Context.current().client),
): PoolActivities {
  const pipeline = {
    ...createEndingActivities(db),
    ...createSweepActivities((candidateId) => sweepStaleClaims(dbSweepPorts(db), candidateId), db),
    ...createRelayActivities(dbReadSignals(db), temporal, db),
    // Registered even while push is off, so a notifier started earlier finds its activity and its
    // pass does nothing (NS-193 slice 3).
    ...createNotifyActivities(dbNotifyPorts(db, config.push)),
  };
  const browser = config.applyBrowser;
  if (!browser.on) return { pipeline, applyBrowser: null };

  // The gateway with its ports, bound per call (browserPorts).
  // The gateway reports its browser steps through onStep, which the activity turns into
  // heartbeats (NS-225 slice 4).
  const submit = (input: SubmitInput, onStep: (step: ApplyStep) => void) =>
    submitApplication(
      dbPorts(
        db,
        {
          ...browserPorts(input.candidateId, browser.chromiumPath, {
            readFile: (c, sha256) => readStoredFile(db, c, sha256),
            launch,
          }),
          onStep,
        },
        config.applyLimits,
      ),
      input,
    );
  const applyBrowser = createApplyActivities(
    submit,
    (candidateId, named) => readDecisionPackage(db, candidateId, named),
    undefined,
    beat,
    (errorClass) =>
      console.error(
        JSON.stringify({ level: "warn", msg: "activity heartbeat failed", errorClass }),
      ),
  );
  return { pipeline, applyBrowser };
}

// One submission's file and browser ports. A file read is scoped to the submission's own
// candidate, and the browser starts only on the form's first open (deferredFormDriver), bound to
// the adapter's hosts the gateway passes in, from the installed Chromium.
export function browserPorts(
  candidateId: CandidateId,
  chromiumPath: string,
  deps: {
    readFile: (candidateId: CandidateId, sha256: string) => Promise<Uint8Array | null>;
    launch: typeof launchFormDriver;
  },
): Pick<ApplyPorts, "readFile" | "openDriver"> {
  return {
    readFile: (sha256) => deps.readFile(candidateId, sha256),
    openDriver: (hosts) =>
      deferredFormDriver(() => deps.launch({ hosts, executablePath: chromiumPath })),
  };
}
