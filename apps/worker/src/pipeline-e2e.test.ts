import { randomUUID } from "node:crypto";
import {
  type Db,
  decideApprovals,
  fitSchema,
  listPendingApprovals,
  PREFERENCE_DEFAULTS,
  profileSchema,
  readPipelineState,
  readPipelineWork,
  saveFitScore,
  savePreferences,
  schema,
  setContact,
  setProfileSetting,
  withdrawApproval,
  writeProfileImport,
} from "@northstar/db";
import { createTestDb, setGateClock } from "@northstar/db/testing";
import { CandidateId } from "@northstar/domain";
import type { FetchDeps } from "@northstar/sources";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPipelineActivities } from "./activities/pipeline.js";
import { createStarterActivities } from "./activities/starter.js";
import type { TemporalPort } from "./client.js";
import { pipelinePorts, starterPorts } from "./wiring.js";
import { runPipeline } from "./workflows/pipeline-run.js";

// The job pipeline end to end (NS-280, #458 "Done when"): a synthetic ready job in the queue band
// becomes a queued application (the starter), a tailored resume, a stored Greenhouse form, a
// package filed with the Gate and a started submission run (the pipeline's activities in
// runPipeline's order), on the real write paths (PGlite) with a fake Greenhouse and a fake
// Temporal. A second pass and run file and start nothing new. Synthetic data only.

const FORM_URL = "https://boards-api.greenhouse.io/v1/boards/globex/jobs/4012345?questions=true";

// Greenhouse's answer for the posting: first name, resume and one factual question.
const FORM = {
  id: 4012345,
  questions: [
    { required: true, label: "First Name", fields: [{ name: "first_name", type: "input_text" }] },
    { required: true, label: "Resume/CV", fields: [{ name: "resume", type: "input_file" }] },
    {
      required: true,
      label: "Will you now or in the future require visa sponsorship?",
      fields: [
        {
          name: "question_1",
          type: "multi_value_single_select",
          values: [
            { label: "Yes", value: 1 },
            { label: "No", value: 0 },
          ],
        },
      ],
    },
  ],
};

// Only the posting's form answers; anything else is a 404, and every host is public.
const fetchDeps: FetchDeps = {
  resolve: async () => ["93.184.216.34"],
  fetch: (async (input: string | URL | Request) =>
    String(input) === FORM_URL
      ? new Response(JSON.stringify(FORM), { headers: { "content-type": "application/json" } })
      : new Response("not found", { status: 404 })) as typeof fetch,
};

// A Temporal that remembers every workflow id it started, like REJECT_DUPLICATE within retention.
function fakeTemporal() {
  const started: string[] = [];
  const port: TemporalPort = {
    async start(workflowType, { workflowId }) {
      if (started.includes(workflowId)) return { started: false };
      started.push(workflowId);
      void workflowType;
      return { started: true };
    },
    async signal() {
      return { delivered: false };
    },
    async waiting() {
      return false;
    },
  };
  return { port, started };
}

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const [c] = await db
    .insert(schema.candidate)
    .values({ displayName: "Test Candidate" })
    .returning();
  if (!c) throw new Error("no candidate");
  candidateId = CandidateId.parse(c.id);
  const [co] = await db.insert(schema.company).values({ candidateId, name: "Globex" }).returning();
  if (!co) throw new Error("no company");
  const [j] = await db
    .insert(schema.job)
    .values({
      candidateId,
      companyId: co.id,
      title: "Backend Engineer",
      url: "https://boards.greenhouse.io/globex/jobs/4012345",
      status: "ready",
      firstSeenAt: new Date(Date.now() - 3_600_000),
    })
    .returning();
  if (!j) throw new Error("no job");
  await db.insert(schema.jobSource).values({
    candidateId,
    jobId: j.id,
    url: "https://boards.greenhouse.io/globex/jobs/4012345",
    method: "ats_api",
    ats: "greenhouse",
    atsPostingId: "4012345",
  });
  await writeProfileImport(db, {
    candidateId,
    fileName: "resume.txt",
    textSha256: "e".repeat(64),
    promptVersion: 1,
    model: "claude-opus-5-5",
    traceId: null,
    call: {},
    extract: { roles: [], education: [], atoms: [], skills: [], certifications: [], links: [] },
  });
  await setContact(db, {
    candidateId,
    contact: { firstName: "Test", lastName: "Person", email: "test@example.com", phone: null },
  });
  await setProfileSetting(db, { candidateId, field: "needs_sponsorship", value: "no" });
  // The job's newest Fit Score is in the queue band.
  await savePreferences(db, { candidateId, values: PREFERENCE_DEFAULTS, now: new Date() });
  const [pref] = await db
    .select({ id: fitSchema.searchPreference.id })
    .from(fitSchema.searchPreference);
  const [source] = await db
    .select({ id: profileSchema.profileSource.id })
    .from(profileSchema.profileSource);
  await saveFitScore(db, {
    candidateId,
    now: new Date(),
    jobId: j.id,
    preferenceId: pref?.id ?? "",
    preferenceVersion: 1,
    profileSourceId: source?.id ?? "",
    jobFingerprint: randomUUID().replaceAll("-", "").padEnd(64, "0"),
    score: 90,
    band: "queue",
    reason: "ok",
    stretch: false,
    components: {},
    evidence: {},
  });
});

afterEach(() => close());

describe("the job pipeline end to end (NS-280)", () => {
  it("takes a ready job to a filed package and one started submission run, and a second pass and run add nothing", async () => {
    const temporal = fakeTemporal();
    const starter = createStarterActivities(
      starterPorts(
        db,
        { on: true, dailyCap: 5 },
        () => temporal.port,
        () => "2026-11-28",
      ),
    );
    const steps = createPipelineActivities(pipelinePorts(db, () => temporal.port, fetchDeps));
    const run = async (applicationId: string) => {
      const args = { candidateId, applicationId };
      return runPipeline({
        tailor: () => steps.tailorResume(args),
        form: () => steps.readJobForm(args),
        prepare: () => steps.preparePackage(args),
        start: (packageSha256) => steps.startSubmission({ ...args, packageSha256 }),
        letter: async () => {
          throw new Error("no letter expected");
        },
        failureOf: () => "failed",
        stop: (code) => {
          throw new Error(`stopped: ${code}`);
        },
      });
    };

    const firstPass = await starter.startPipelines({ candidateId });
    const [pipelineId] = temporal.started;
    const applicationId = pipelineId?.split(":")[1] ?? "";
    const first = await run(applicationId);
    const state = await readPipelineState(db, candidateId, applicationId);
    const afterFirst = {
      starts: [...temporal.started],
      pending: (await listPendingApprovals(db, candidateId)).length,
    };

    const secondPass = await starter.startPipelines({ candidateId });
    const second = await run(applicationId);

    expect([
      firstPass.on && [firstPass.queue.queued, firstPass.pipelines.started],
      first,
      state?.status,
      afterFirst.starts,
      afterFirst.pending,
      secondPass.on && [
        secondPass.queue.queued,
        secondPass.pipelines.started,
        secondPass.submissions,
      ],
      second,
      temporal.started,
      (await listPendingApprovals(db, candidateId)).length,
    ]).toEqual([
      [1, 1],
      { kind: "submission_started", packageSha256: state?.packageSha256 },
      "awaiting_approval",
      [
        `pipeline:${applicationId}:0:2026-11-28`,
        `submission:${applicationId}:${state?.packageSha256}`,
      ],
      1,
      [0, 0, { started: 0, existing: 1 }],
      { kind: "submission_exists", packageSha256: state?.packageSha256 },
      afterFirst.starts,
      1,
    ]);
  });

  // A filed round: the starter queues and starts the job, the pipeline's steps file its package.
  async function fileRound() {
    const temporal = fakeTemporal();
    const starter = createStarterActivities(
      starterPorts(
        db,
        { on: true, dailyCap: 5 },
        () => temporal.port,
        () => "2026-11-28",
      ),
    );
    const steps = createPipelineActivities(pipelinePorts(db, () => temporal.port, fetchDeps));
    await starter.startPipelines({ candidateId });
    const applicationId = temporal.started[0]?.split(":")[1] ?? "";
    const args = { candidateId, applicationId };
    await steps.tailorResume(args);
    await steps.readJobForm(args);
    await steps.preparePackage(args);
    const [request] = await listPendingApprovals(db, candidateId);
    return { temporal, starter, applicationId, requestId: request?.requestId ?? "" };
  }
  const openRounds = async () =>
    (await readPipelineWork(db, candidateId)).openRounds.map((r) => r.applicationId);

  it("never starts a round's submission again once Paul withdrew its request", async () => {
    const { temporal, starter, applicationId, requestId } = await fileRound();
    const before = await openRounds();
    const withdrawn = await withdrawApproval(db, { candidateId, requestId, by: "user" });
    const startsBefore = temporal.started.length;
    const pass = await starter.startPipelines({ candidateId });
    expect([
      before,
      withdrawn.ok,
      await openRounds(),
      pass.on && pass.submissions,
      temporal.started.length - startsBefore,
    ]).toEqual([[applicationId], true, [], { started: 0, existing: 0 }, 0]);
  });

  it("never lists a round Paul rejected", async () => {
    const { requestId } = await fileRound();
    await decideApprovals(db, {
      candidateId,
      requestIds: [requestId],
      decision: "reject",
      reason: "not this one",
    });
    expect(await openRounds()).toEqual([]);
  });

  it("lists an approved round only within the hour after its approval took effect, so an ended run is never restarted later", async () => {
    const now = Date.now();
    await setGateClock(db, new Date(now));
    const { applicationId, requestId } = await fileRound();
    await decideApprovals(db, { candidateId, requestIds: [requestId], decision: "approve" });
    // Past the 2-minute undo window: the approval has taken effect.
    await setGateClock(db, new Date(now + 10 * 60_000));
    const soon = await openRounds();
    await setGateClock(db, new Date(now + 2 * 3_600_000));
    expect([soon, await openRounds()]).toEqual([[applicationId], []]);
  });
});
