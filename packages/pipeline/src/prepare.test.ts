import {
  type Db,
  decideApprovals,
  type JobFormQuestion,
  listPendingApprovals,
  profileSchema,
  readEventsAfter,
  readPackageInputs,
  saveJobForm,
  saveTailoredResume,
  schema,
  setContact,
  setProfileSetting,
  transitionApplication,
  writeProfileImport,
} from "@northstar/db";
import { createTestDb, seedApplication } from "@northstar/db/testing";
import { ApplicationId, CandidateId, type ContactDetails } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { packageIdFor, preparePackage, resumeFileName } from "./prepare.js";

// The package caller (NS-227 slice 6) on the real write paths (PGlite). Synthetic data only.

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let applicationId: string;
let jobId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const seeded = await seedApplication(db, "queued");
  candidateId = CandidateId.parse(seeded.candidateId);
  applicationId = seeded.applicationId;
  jobId = seeded.jobId;
});
afterEach(() => close());

const CONTACT: ContactDetails = {
  firstName: "Test",
  lastName: "Person",
  email: "test@example.com",
  phone: null,
};

// One required factual question the settings answer, after Greenhouse's standard fields.
const SPONSORSHIP: JobFormQuestion = {
  fieldName: "question_1",
  label: "Will you now or in the future require visa sponsorship?",
  required: true,
  kind: "select",
  choices: [
    { label: "Yes", value: "1" },
    { label: "No", value: "0" },
  ],
  group: 2,
};
const STANDARD: JobFormQuestion[] = [
  {
    fieldName: "first_name",
    label: "First Name",
    required: true,
    kind: "text",
    choices: null,
    group: 0,
  },
  {
    fieldName: "resume",
    label: "Resume/CV",
    required: true,
    kind: "file",
    choices: null,
    group: 1,
  },
];

// Everything a complete package needs: a Greenhouse source, the form, contact, a setting and a
// tailored resume with its PDF.
async function complete(form: JobFormQuestion[] = [...STANDARD, SPONSORSHIP]): Promise<void> {
  await db.insert(schema.jobSource).values({
    candidateId,
    jobId,
    url: "https://boards.greenhouse.io/globex/jobs/4012345",
    method: "ats_api",
    ats: "greenhouse",
    atsPostingId: "4012345",
  });
  await saveJobForm(db, { candidateId, jobId, ats: "greenhouse", questions: form });
  await setContact(db, { candidateId, contact: CONTACT });
  await setProfileSetting(db, { candidateId, field: "needs_sponsorship", value: "no" });
  await tailor();
}

async function tailor(): Promise<void> {
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
  const [source] = await db
    .select({ id: profileSchema.profileSource.id })
    .from(profileSchema.profileSource);
  await saveTailoredResume(db, {
    candidateId,
    jobId,
    profileSourceId: source?.id ?? "",
    resume: {},
    validation: {},
    score: {},
    droppedSkills: [],
    summary: {
      lines: 0,
      atoms: 0,
      addedSkills: 0,
      droppedSkills: 0,
      notClaimed: 0,
      keywordsCovered: 0,
      keywordsTotal: 0,
      titleMatch: "none",
      atsPass: true,
      valid: true,
      failures: 0,
    },
    pdf: new TextEncoder().encode("%PDF-1.7 synthetic"),
  });
}

const prepare = () => preparePackage(db, { candidateId, applicationId });
const status = async () =>
  (await readPackageInputs(db, candidateId, applicationId))?.application.status;
const needsYou = async () =>
  (await readEventsAfter(db, candidateId, 0n, 500)).filter(
    (e) => e.event.type === "package.needs_human",
  );

// A run that filed its package and then died before awaiting_approval: a trigger refuses that one
// move, the run throws, and the trigger is dropped again.
async function crashBeforeAwaitingApproval(): Promise<void> {
  const pg = (db as unknown as { $client: { exec(q: string): Promise<unknown> } }).$client;
  await pg.exec(`
    create function test_crash() returns trigger language plpgsql as $$
    begin raise exception 'test crash'; end $$;
    create trigger test_crash before update on application for each row
      when (new.status = 'awaiting_approval') execute function test_crash();`);
  const crashed = await prepare().then(
    () => false,
    () => true,
  );
  await pg.exec("drop trigger test_crash on application; drop function test_crash();");
  if (!crashed || (await status()) !== "package_ready") throw new Error("the crash didn't happen");
}

describe("packageIdFor and resumeFileName", () => {
  it("gives the same version 8 id for the same application, round and content, and another otherwise", () => {
    const a = packageIdFor(applicationId, 0, "a".repeat(64));
    expect([
      a === packageIdFor(applicationId, 0, "a".repeat(64)),
      a === packageIdFor(applicationId, 0, "b".repeat(64)),
      a === packageIdFor(applicationId, 1, "a".repeat(64)),
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(a),
    ]).toEqual([true, false, false, true]);
  });

  it("names the resume after Paul in plain characters, or plainly when the name has none", () => {
    expect([
      resumeFileName({ firstName: "Test", lastName: "Person" }),
      resumeFileName({ firstName: "José Luis", lastName: "O'Brien" }),
      resumeFileName({ firstName: "Renée", lastName: "Müller" }),
      resumeFileName({ firstName: "李", lastName: "明" }),
      resumeFileName({ firstName: "A".repeat(150), lastName: "B" }).endsWith("-B-resume.pdf"),
    ]).toEqual([
      "Test-Person-resume.pdf",
      "Jose-Luis-O-Brien-resume.pdf",
      "Renee-Muller-resume.pdf",
      "resume.pdf",
      true,
    ]);
  });
});

describe("preparePackage", () => {
  it("files a complete package with the Gate and moves the application to awaiting_approval", async () => {
    await complete();
    const result = await prepare();
    const pending = await listPendingApprovals(db, candidateId);
    expect([
      result.kind,
      await status(),
      pending.map((p) => [p.kind, p.subject.startsWith("application_package:")]),
    ]).toEqual(["filed", "awaiting_approval", [["application_package", true]]]);
  });

  it("files nothing new on a rerun: the application is no longer queued", async () => {
    await complete();
    await prepare();
    expect([await prepare(), (await listPendingApprovals(db, candidateId)).length]).toEqual([
      { kind: "refused", reason: "not_queued" },
      1,
    ]);
  });

  it("finishes a run that crashed after filing, replaying the same Gate request", async () => {
    await complete();
    await crashBeforeAwaitingApproval();
    const result = await prepare();
    expect([
      result.kind === "filed" && [result.replayed, result.autoApproved, result.decision],
      await status(),
      (await listPendingApprovals(db, candidateId)).length,
    ]).toEqual([[true, false, null], "awaiting_approval", 1]);
  });

  it("reports a crashed round's request Paul rejected meanwhile as rejected, never auto-approved", async () => {
    await complete();
    await crashBeforeAwaitingApproval();
    const [pending] = await listPendingApprovals(db, candidateId);
    await decideApprovals(db, {
      candidateId,
      requestIds: [pending?.requestId ?? ""],
      decision: "reject",
      reason: "not this one",
    });
    const result = await prepare();
    expect(
      result.kind === "filed" && [result.replayed, result.autoApproved, result.decision],
    ).toEqual([true, false, "rejected"]);
  });

  it("files nothing beside a crashed round's package when the inputs changed since", async () => {
    await complete();
    await crashBeforeAwaitingApproval();
    await setProfileSetting(db, { candidateId, field: "needs_sponsorship", value: "yes" });
    expect([
      await prepare(),
      await status(),
      (await listPendingApprovals(db, candidateId)).length,
    ]).toEqual([
      { kind: "needs_human", reasons: { inputs_changed: 1 }, recorded: true },
      "package_ready",
      1,
    ]);
  });

  it("files a new package in the next round after a rejection, even for the same content", async () => {
    await complete();
    const first = await prepare();
    const [pending] = await listPendingApprovals(db, candidateId);
    await decideApprovals(db, {
      candidateId,
      requestIds: [pending?.requestId ?? ""],
      decision: "reject",
      reason: "not this one",
    });
    await transitionApplication(db, {
      candidateId,
      applicationId: ApplicationId.parse(applicationId),
      from: "awaiting_approval",
      to: "queued",
      actor: "system",
      reason: "",
      inputsSummary: "",
      links: [],
      idempotencyKey: `application:${applicationId}:test:requeued`,
    });
    const second = await prepare();
    expect([
      second.kind === "filed" && [second.replayed, second.decision],
      first.kind === "filed" && second.kind === "filed" && first.packageId !== second.packageId,
      await status(),
      (await listPendingApprovals(db, candidateId)).length,
    ]).toEqual([[false, null], true, "awaiting_approval", 1]);
  });

  it("refuses an unknown application and one that isn't queued", async () => {
    const sent = await seedApplication(db, "submitted");
    expect([
      await preparePackage(db, {
        candidateId,
        applicationId: "00000000-0000-4000-8000-000000000001",
      }),
      await preparePackage(db, {
        candidateId: CandidateId.parse(sent.candidateId),
        applicationId: sent.applicationId,
      }),
    ]).toEqual([
      { kind: "refused", reason: "not_found" },
      { kind: "refused", reason: "not_queued" },
    ]);
  });

  it("lists every missing input as a reason, files nothing and stays queued", async () => {
    expect([
      await prepare(),
      await status(),
      (await listPendingApprovals(db, candidateId)).length,
    ]).toEqual([
      {
        kind: "needs_human",
        reasons: { no_ats_source: 1, no_contact: 1, no_form: 1, no_resume_file: 1 },
        recorded: true,
      },
      "queued",
      0,
    ]);
  });

  it("stops before filing when the form requires a phone and Paul has none", async () => {
    await complete([
      ...STANDARD,
      { fieldName: "phone", label: "Phone", required: true, kind: "text", choices: null, group: 3 },
      SPONSORSHIP,
    ]);
    expect([await prepare(), (await listPendingApprovals(db, candidateId)).length]).toEqual([
      { kind: "needs_human", reasons: { no_phone: 1 }, recorded: true },
      0,
    ]);
  });

  it("stops before filing when the form requires an upload Northstar can't fill", async () => {
    await complete([
      ...STANDARD,
      SPONSORSHIP,
      {
        fieldName: "question_9",
        label: "Writing sample",
        required: true,
        kind: "file",
        choices: null,
        group: 4,
      },
    ]);
    expect([await prepare(), (await listPendingApprovals(db, candidateId)).length]).toEqual([
      { kind: "needs_human", reasons: { file_upload: 1 }, recorded: true },
      0,
    ]);
  });

  it("names an unanswered question's reason, and records the line once for the same inputs", async () => {
    await complete([
      ...STANDARD,
      SPONSORSHIP,
      {
        fieldName: "question_2",
        label: "Why do you want to work here?",
        required: true,
        kind: "textarea",
        choices: null,
        group: 5,
      },
    ]);
    const first = await prepare();
    const second = await prepare();
    expect([first, second, (await needsYou()).length]).toEqual([
      { kind: "needs_human", reasons: { no_bank_answer: 1 }, recorded: true },
      { kind: "needs_human", reasons: { no_bank_answer: 1 }, recorded: false },
      1,
    ]);
  });
});
