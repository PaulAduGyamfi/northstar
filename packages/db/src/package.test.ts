import { randomUUID } from "node:crypto";
import { CandidateId, feedLine, UNDO_WINDOW_MS } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answerContentSha256, saveApprovedAnswer } from "./answer-write.js";
import { applySubmission } from "./apply-schema.js";
import { decideApprovals, requestApproval } from "./approval-write.js";
import { setContact } from "./contact-write.js";
import type { Db } from "./db.js";
import { searchPreference } from "./fit-schema.js";
import { PREFERENCE_DEFAULTS, saveFitScore, savePreferences } from "./fit-write.js";
import { type JobFormQuestion, jobForm } from "./job-form-schema.js";
import { saveJobForm } from "./job-form-write.js";
import { readPackageInputs } from "./package-read.js";
import { recordPackageNeedsHuman } from "./package-write.js";
import { profileSource } from "./profile-schema.js";
import { writeProfileImport } from "./profile-write.js";
import { application, domainEvent, job, jobSource } from "./schema.js";
import { setProfileSetting } from "./settings-write.js";
import { saveTailoredResume } from "./tailor-write.js";
import { createTestDb, seedApplication } from "./test/pglite.js";

// A package's inputs and the needs-you event (NS-227 slice 5). Synthetic data only.

const NOW = new Date("2026-11-25T12:00:00Z");

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let applicationId: string;
let jobId: string;
let companyId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const seeded = await seedApplication(db, "queued");
  candidateId = CandidateId.parse(seeded.candidateId);
  applicationId = seeded.applicationId;
  jobId = seeded.jobId;
  companyId = seeded.companyId;
  await setClock(NOW);
});

afterEach(async () => {
  await close();
});

let clock = NOW;
async function setClock(at: Date): Promise<void> {
  clock = at;
  await db.execute(sql`select set_config('northstar.gate_test_now', ${at.toISOString()}, false)`);
}

const FORM: JobFormQuestion[] = [
  {
    fieldName: "question_1",
    label: "Why this team?",
    required: true,
    kind: "textarea",
    choices: null,
    group: 0,
  },
];

// A resume import, so a tailored version and a fit score have a source to cite.
async function importResume(): Promise<string> {
  await writeProfileImport(db, {
    candidateId,
    fileName: "resume.txt",
    textSha256: "e".repeat(64),
    promptVersion: 1,
    model: "claude-opus-5-5",
    traceId: null,
    call: {},
    extract: {
      roles: [],
      education: [],
      atoms: [],
      skills: [],
      certifications: [],
      links: [],
    },
  });
  const [source] = await db.select({ id: profileSource.id }).from(profileSource);
  if (!source) throw new Error("no source");
  return source.id;
}

// One banked answer for a canonical question, approved through the Gate (as answer-bank does).
// An approved Gate decision for an answer, as the answer bank gets one.
async function approvedDecision(answerId: string, content: AnswerDraft): Promise<string> {
  const requested = await requestApproval(db, {
    candidateId,
    kind: "answer",
    subject: `answer:${answerId}`,
    contentSha256: answerContentSha256({ ...content, kind: "company_specific", applicationId }),
    facts: null,
    actor: "agent:answers",
    idempotencyKey: randomUUID(),
  });
  if (!requested.ok) throw new Error(requested.error.kind);
  const decided = await decideApprovals(db, {
    candidateId,
    requestIds: [requested.value.requestId],
    decision: "approve",
  });
  const result = decided.ok ? decided.value[0]?.result : undefined;
  if (!result?.ok) throw new Error("not approved");
  return result.value.decisionId;
}
type AnswerDraft = { canonicalId: string; shortText: string; longText: string | null };

// One banked answer for a canonical question, approved through the Gate (as answer-bank does).
async function bankAnswer(canonicalId: string, shortText: string): Promise<void> {
  const answerId = randomUUID();
  const content: AnswerDraft = { canonicalId, shortText, longText: null };
  const decisionId = await approvedDecision(answerId, content);
  await setClock(new Date(clock.getTime() + UNDO_WINDOW_MS + 60_000));
  const saved = await saveApprovedAnswer(db, {
    candidateId,
    answerId,
    decisionId,
    applicationId,
    kind: "company_specific",
    edited: false,
    confidence: 0.9,
    storyIds: [],
    atomIds: [],
    traceId: null,
    ...content,
  });
  if (!saved.ok) throw new Error(saved.error.kind);
}

// Another job of `owner`'s, with its own application at `status`.
async function otherJob(
  status: string,
  owner = candidateId,
  ownerCompany: string | null = companyId,
) {
  const [row] = await db
    .insert(job)
    .values({
      candidateId: owner,
      companyId: ownerCompany,
      title: "Other role",
      url: "https://jobs.example.com/other",
      status: "ready",
    })
    .returning({ id: job.id });
  if (!row) throw new Error("no job");
  const [app] = await db
    .insert(application)
    .values({ candidateId: owner, jobId: row.id, status })
    .returning({ id: application.id });
  if (!app) throw new Error("no application");
  return { jobId: row.id, applicationId: app.id };
}

// A stored form row at a known time (job_form is append-only; rows are only ever added).
const formRow = (
  jobId: string,
  sha256: string,
  readAt: Date,
  over: { ats?: string; owner?: CandidateId } = {},
) =>
  db.insert(jobForm).values({
    candidateId: over.owner ?? candidateId,
    jobId,
    ats: over.ats ?? "greenhouse",
    sha256,
    questions: FORM,
    readAt,
  });

// The Apply Gateway's ledger row for a submission that finished at `finishedAt`.
async function gatewaySubmitted(
  app: string,
  finishedAt: Date,
  owner = candidateId,
  ending: { status: "submitted" | "needs_human"; reason: string | null } = {
    status: "submitted",
    reason: null,
  },
): Promise<void> {
  const decisionId = await approvedDecision(randomUUID(), {
    canonicalId: "why-this-role",
    shortText: "A synthetic answer.",
    longText: null,
  });
  await db.insert(applySubmission).values({
    candidateId: owner,
    applicationId: app,
    decisionId,
    ats: "greenhouse",
    requisitionKey: `greenhouse:${randomUUID()}`,
    idempotencyKey: `application:${app}:submit`,
    status: ending.status,
    reason: ending.reason,
    startedAt: new Date(finishedAt.getTime() - 60_000),
    finishedAt,
  });
}

describe("readPackageInputs", () => {
  it("reads nothing for an unknown, malformed or other candidate's application", async () => {
    const other = await seedApplication(db, "queued");
    expect([
      await readPackageInputs(db, candidateId, randomUUID()),
      await readPackageInputs(db, candidateId, "not-an-id"),
      await readPackageInputs(db, CandidateId.parse(other.candidateId), applicationId),
    ]).toEqual([null, null, null]);
  });

  it("reads the application and its company, with nothing else stored yet", async () => {
    expect(await readPackageInputs(db, candidateId, applicationId)).toEqual({
      application: { id: applicationId, status: "queued", jobId },
      companyName: "Example Corp",
      sources: [],
      contact: null,
      resume: null,
      settings: [],
      bank: [],
      form: null,
      fit: null,
      formSeenBefore: false,
    });
  });

  it("reads the contact, settings, sources, form, tailored resume and fit score", async () => {
    const sourceId = await importResume();
    await setContact(db, {
      candidateId,
      contact: { firstName: "Test", lastName: "Person", email: "test@example.com", phone: null },
    });
    await setProfileSetting(db, { candidateId, field: "notice_period", value: "2 weeks" });
    await db.insert(jobSource).values({
      candidateId,
      jobId,
      url: "https://boards.greenhouse.io/globex/jobs/4012345",
      method: "ats_api",
      ats: "greenhouse",
      atsPostingId: "4012345",
    });
    await saveJobForm(db, { candidateId, jobId, ats: "greenhouse", questions: FORM });
    const pdf = new TextEncoder().encode("%PDF-1.7 synthetic");
    await saveTailoredResume(db, {
      candidateId,
      jobId,
      profileSourceId: sourceId,
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
      pdf,
    });
    await savePreferences(db, { candidateId, values: PREFERENCE_DEFAULTS, now: NOW });
    const [pref] = await db.select({ id: searchPreference.id }).from(searchPreference);
    await saveFitScore(db, {
      candidateId,
      now: NOW,
      jobId,
      preferenceId: pref?.id ?? "",
      preferenceVersion: 1,
      profileSourceId: sourceId,
      jobFingerprint: "f".repeat(64),
      score: 82,
      band: "queue",
      reason: "ok",
      stretch: false,
      components: {},
      evidence: {},
    });
    const inputs = await readPackageInputs(db, candidateId, applicationId);
    expect({
      contact: inputs?.contact?.email,
      settings: inputs?.settings.map((s) => s.field),
      sources: inputs?.sources,
      form: [inputs?.form?.ats, inputs?.form?.questions],
      resume: inputs?.resume?.version,
      pdf: inputs?.resume?.pdfSha256?.length,
      fit: inputs?.fit,
    }).toEqual({
      contact: "test@example.com",
      settings: ["notice_period"],
      sources: [
        {
          ats: "greenhouse",
          url: "https://boards.greenhouse.io/globex/jobs/4012345",
          postingId: "4012345",
        },
      ],
      form: ["greenhouse", FORM],
      resume: 1,
      pdf: 64,
      fit: 82,
    });
  });

  it("reads the newest banked answer for each canonical question", async () => {
    await bankAnswer("why-this-role", "First answer.");
    await bankAnswer("why-this-role", "Second answer.");
    await bankAnswer("why-this-company", "Company answer.");
    const bank = (await readPackageInputs(db, candidateId, applicationId))?.bank ?? [];
    expect(bank.map((b) => [b.canonicalId, b.version, b.shortText])).toEqual([
      ["why-this-company", 1, "Company answer."],
      ["why-this-role", 2, "Second answer."],
    ]);
  });
});

describe("formSeenBefore", () => {
  const T0 = new Date("2026-11-01T00:00:00Z");
  const T1 = new Date("2026-11-02T00:00:00Z");
  const T2 = new Date("2026-11-03T00:00:00Z");
  const OTHER_SHAPE = "b".repeat(64);
  let shape: string;
  beforeEach(async () => {
    await saveJobForm(db, { candidateId, jobId, ats: "greenhouse", questions: FORM });
    const [row] = await db.select({ sha256: jobForm.sha256 }).from(jobForm);
    shape = row?.sha256 ?? "";
  });
  const seen = async () =>
    (await readPackageInputs(db, candidateId, applicationId))?.formSeenBefore;

  it("is true when the Apply Gateway sent another job's application with this form shape", async () => {
    const other = await otherJob("submitted");
    await formRow(other.jobId, shape, T0);
    await gatewaySubmitted(other.applicationId, T1);
    expect(await seen()).toBe(true);
  });

  it("is false when Paul sent that application himself (no Apply Gateway submission)", async () => {
    const other = await otherJob("submitted");
    await formRow(other.jobId, shape, T0);
    expect(await seen()).toBe(false);
  });

  it("is false when the Apply Gateway's run on it ended needing Paul", async () => {
    const other = await otherJob("needs_human");
    await formRow(other.jobId, shape, T0);
    await gatewaySubmitted(other.applicationId, T1, candidateId, {
      status: "needs_human",
      reason: "captcha",
    });
    expect(await seen()).toBe(false);
  });

  it("is false when the other job's form had another shape when it went out", async () => {
    const other = await otherJob("submitted");
    await formRow(other.jobId, OTHER_SHAPE, T0);
    await gatewaySubmitted(other.applicationId, T1);
    // The job took on this shape only after its application went out.
    await formRow(other.jobId, shape, T2);
    expect(await seen()).toBe(false);
  });

  it("is still true when the other job's form changed after it went out with this shape", async () => {
    const other = await otherJob("submitted");
    await formRow(other.jobId, shape, T0);
    await gatewaySubmitted(other.applicationId, T1);
    await formRow(other.jobId, OTHER_SHAPE, T2);
    expect(await seen()).toBe(true);
  });

  it("is false when the same shape went out on another ATS", async () => {
    const other = await otherJob("submitted");
    await formRow(other.jobId, shape, T0, { ats: "lever" });
    await gatewaySubmitted(other.applicationId, T1);
    expect(await seen()).toBe(false);
  });

  it("is false when the shape went out only for another candidate", async () => {
    const stranger = await seedApplication(db, "submitted");
    const owner = CandidateId.parse(stranger.candidateId);
    await formRow(stranger.jobId, shape, T0, { owner });
    await gatewaySubmitted(stranger.applicationId, T1, owner);
    expect(await seen()).toBe(false);
  });

  it("is false when the only submission with this shape is this job's own", async () => {
    await gatewaySubmitted(applicationId, new Date(Date.now() + 60_000));
    expect(await seen()).toBe(false);
  });
});

describe("recordPackageNeedsHuman", () => {
  const BASIS = "a".repeat(64);
  const events = () =>
    db
      .select({
        payload: domainEvent.payload,
        reason: domainEvent.reason,
        aggregate: domainEvent.aggregate,
      })
      .from(domainEvent)
      .where(eq(domainEvent.type, "package.needs_human"));

  it("writes one event with the codes and counts, and its feed line", async () => {
    const result = await recordPackageNeedsHuman(db, {
      candidateId,
      applicationId,
      reasons: { no_phone: 1, no_bank_answer: 2 },
      basis: BASIS,
    });
    expect([result, await events()]).toEqual([
      { ok: true, value: { recorded: true } },
      [
        {
          aggregate: `application:${applicationId}`,
          reason: "The application package needs you: 3 items",
          payload: { applicationId, reasons: { no_bank_answer: 2, no_phone: 1 }, items: 3 },
        },
      ],
    ]);
  });

  it("shows its own line in the feed, not a status change", async () => {
    await recordPackageNeedsHuman(db, {
      candidateId,
      applicationId,
      reasons: { no_phone: 1 },
      basis: BASIS,
    });
    const [row] = await db
      .select({
        type: domainEvent.type,
        actor: domainEvent.actor,
        reason: domainEvent.reason,
        payload: domainEvent.payload,
      })
      .from(domainEvent)
      .where(eq(domainEvent.type, "package.needs_human"));
    if (!row) throw new Error("no event");
    expect(feedLine({ ...row, payload: row.payload as Record<string, unknown> })).toBe(
      "The application package needs you: 1 item",
    );
  });

  it("writes nothing more for the same basis", async () => {
    const input = { candidateId, applicationId, reasons: { no_phone: 1 }, basis: BASIS };
    await recordPackageNeedsHuman(db, input);
    expect([await recordPackageNeedsHuman(db, input), (await events()).length]).toEqual([
      { ok: true, value: { recorded: false } },
      1,
    ]);
  });

  it("refuses a code that isn't a short snake_case word, a bad basis and another's application", async () => {
    const other = await seedApplication(db, "queued");
    const refused = { ok: false, error: { kind: "InvalidNeedsHuman" } };
    expect([
      await recordPackageNeedsHuman(db, {
        candidateId,
        applicationId,
        reasons: { "Why this team?": 1 },
        basis: BASIS,
      }),
      await recordPackageNeedsHuman(db, { candidateId, applicationId, reasons: {}, basis: BASIS }),
      await recordPackageNeedsHuman(db, {
        candidateId,
        applicationId,
        reasons: { no_phone: 1 },
        basis: "short",
      }),
      await recordPackageNeedsHuman(db, {
        candidateId,
        applicationId: other.applicationId,
        reasons: { no_phone: 1 },
        basis: BASIS,
      }),
      (await events()).length,
    ]).toEqual([refused, refused, refused, refused, 0]);
  });
});
