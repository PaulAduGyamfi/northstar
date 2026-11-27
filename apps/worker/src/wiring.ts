import { type Db, readDecisionPackage, readStoredFile } from "@northstar/db";
import type { CandidateId } from "@northstar/domain";
import {
  type ApplyPorts,
  dbPorts,
  dbSweepPorts,
  deferredFormDriver,
  launchFormDriver,
  type SubmitInput,
  submitApplication,
  sweepStaleClaims,
} from "@northstar/gateways";
import { createApplyActivities } from "./activities/apply.js";
import { createEndingActivities } from "./activities/ending.js";
import { createSweepActivities } from "./activities/sweep.js";
import type { WorkerConfig } from "./config.js";

// The activities each pool runs, bound to the real write paths (NS-225). Plain code with no
// Temporal connection, so the wiring is tested without a server; main.ts hands these to its
// Workers. Each queue gets only its own activities (RES-001): the pipeline pool never opens a
// browser, and the browser pool exists only while Paul has turned it on.

export type PoolActivities = {
  pipeline: ReturnType<typeof createEndingActivities> & ReturnType<typeof createSweepActivities>;
  // Null while WORKER_APPLY_BROWSER is off: nothing can be submitted.
  applyBrowser: ReturnType<typeof createApplyActivities> | null;
};

// `launch` is launchFormDriver; a test passes a fake so no browser starts.
export function workerActivities(
  db: Db,
  config: Pick<WorkerConfig, "applyBrowser" | "applyLimits">,
  launch: typeof launchFormDriver = launchFormDriver,
): PoolActivities {
  const pipeline = {
    ...createEndingActivities(db),
    ...createSweepActivities((candidateId) => sweepStaleClaims(dbSweepPorts(db), candidateId), db),
  };
  const browser = config.applyBrowser;
  if (!browser.on) return { pipeline, applyBrowser: null };

  // The gateway with its ports, bound per call (browserPorts).
  const submit = (input: SubmitInput) =>
    submitApplication(
      dbPorts(
        db,
        browserPorts(input.candidateId, browser.chromiumPath, {
          readFile: (c, sha256) => readStoredFile(db, c, sha256),
          launch,
        }),
        config.applyLimits,
      ),
      input,
    );
  const applyBrowser = createApplyActivities(submit, (candidateId, named) =>
    readDecisionPackage(db, candidateId, named),
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
