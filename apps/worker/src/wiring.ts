import { lookup } from "node:dns/promises";
import {
  type Db,
  readDecisionPackage,
  readIndependentWork,
  readJobAtsSources,
  readPipelineState,
  readPipelineWork,
  readStoredFile,
  readTailorInput,
  recordDeadLetter,
  saveJobForm,
  saveTailoredResume,
} from "@northstar/db";
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
import { preparePackage, queueReadyJobs } from "@northstar/pipeline";
import { tailorForJob } from "@northstar/profile";
import {
  dbPollGuard,
  detectAts,
  type FetchDeps,
  readGreenhouseFormResult,
} from "@northstar/sources";
import { Context } from "@temporalio/activity";
import { type BeatStep, createApplyActivities } from "./activities/apply.js";
import { createEndingActivities } from "./activities/ending.js";
import { createNotifyActivities } from "./activities/notify.js";
import { createPipelineActivities, type PipelinePorts } from "./activities/pipeline.js";
import { createRelayActivities, dbReadSignals } from "./activities/relay.js";
import { createStarterActivities, type StarterPorts, starterLetter } from "./activities/starter.js";
import { createSweepActivities } from "./activities/sweep.js";
import { startJobPipeline, startSubmission, type TemporalPort, temporalPort } from "./client.js";
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
    ReturnType<typeof createNotifyActivities> &
    ReturnType<typeof createPipelineActivities> &
    ReturnType<typeof createStarterActivities>;
  // Null while WORKER_APPLY_BROWSER is off: nothing can be submitted.
  applyBrowser: ReturnType<typeof createApplyActivities> | null;
};

// `launch` is launchFormDriver and `beat` Temporal's activity heartbeat (the step name is its
// only detail, never a value); a test passes fakes so no browser starts. `temporal` is the
// relay's way to Temporal: the worker's own client, from the running activity's context (NS-213
// slice 2), so no second connection.
export function workerActivities(
  db: Db,
  config: Pick<WorkerConfig, "applyBrowser" | "applyLimits" | "push" | "jobPipeline">,
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
    // The job pipeline (NS-280 slice 2): registered always; nothing starts a run yet (slice 3).
    ...createPipelineActivities(pipelinePorts(db, temporal)),
    // Its starter (slice 3): registered always, and does nothing while WORKER_JOB_PIPELINE is off.
    ...createStarterActivities(starterPorts(db, config.jobPipeline, temporal)),
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

// The safe fetcher's host lookup: every address a name resolves to (it refuses private ones).
const fetchDeps: FetchDeps = {
  resolve: async (host) => (await lookup(host, { all: true })).map((a) => a.address),
  fetch,
};

// The job pipeline's ports on the real write paths (NS-280 slice 2): the same functions the
// `profile tailor`, `jobs form` and package commands use, scoped to the run's candidate.
export function pipelinePorts(
  db: Db,
  temporal: () => TemporalPort,
  deps: FetchDeps = fetchDeps,
): PipelinePorts {
  return {
    state: (candidateId, applicationId) => readPipelineState(db, candidateId, applicationId),
    tailor: async (candidateId, jobId) => {
      const run = await tailorForJob(
        {
          readInput: (id) => readTailorInput(db, candidateId, id),
          save: (input) => saveTailoredResume(db, { ...input, candidateId }),
          // The independent-work section (NS-231), as `profile tailor` reads it.
          readWork: async () => {
            const view = await readIndependentWork(db, candidateId);
            return view === null ? null : { version: view.version, entries: view.entries };
          },
        },
        jobId,
        [],
      );
      if (run.kind === "tailored") return { kind: "tailored", saved: run.saved };
      return run.kind === "refused"
        ? { kind: "refused", reason: run.reason }
        : { kind: "bad_toggle", reason: "bad_toggle" };
    },
    formTarget: async (candidateId, jobId) => {
      // The first Greenhouse source whose link names its board and posting (as `jobs form`).
      for (const source of await readJobAtsSources(db, candidateId, jobId)) {
        const target = detectAts(source.url);
        if (target?.ats === "greenhouse")
          return { board: target.board, postingId: target.postingId };
      }
      return null;
    },
    guard: (candidateId) => dbPollGuard(db, candidateId),
    readForm: (t) => readGreenhouseFormResult(deps, t),
    saveForm: (candidateId, jobId, questions) =>
      saveJobForm(db, { candidateId, jobId, ats: "greenhouse", questions, actor: "system" }),
    prepare: (candidateId, applicationId) => preparePackage(db, { candidateId, applicationId }),
    start: (input) => startSubmission(temporal(), input),
    recordLetter: (letter) =>
      recordDeadLetter(db, {
        candidateId: letter.candidateId,
        kind: "pipeline.job",
        subject: `application:${letter.applicationId}`,
        reasonCode: letter.reasonCode,
        attempts: letter.attempts,
        idempotencyKey: letter.idempotencyKey,
      }),
  };
}

// The starter's ports (NS-280 slice 3): the queueing rule, the work reader, and starts on the
// worker's own client.
export function starterPorts(
  db: Db,
  setting: WorkerConfig["jobPipeline"],
  temporal: () => TemporalPort,
  today: () => string = () => new Date().toISOString().slice(0, 10),
): StarterPorts {
  return {
    setting,
    queue: (candidateId, dailyCap) => queueReadyJobs(db, candidateId, { dailyCap }),
    work: (candidateId) => readPipelineWork(db, candidateId),
    startPipeline: (input, at) => startJobPipeline(temporal(), input, at),
    startSubmission: (input) => startSubmission(temporal(), input),
    today,
    recordLetter: ({ candidateId, key }) => recordDeadLetter(db, starterLetter(candidateId, key)),
  };
}
