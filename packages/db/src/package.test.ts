import { randomUUID } from "node:crypto";
import { CandidateId, UNDO_WINDOW_MS } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answerContentSha256, saveApprovedAnswer } from "./answer-write.js";
import { decideApprovals, requestApproval } from "./approval-write.js";
import { setContact } from "./contact-write.js";
import type { Db } from "./db.js";
import { searchPreference } from "./fit-schema.js";
import { PREFERENCE_DEFAULTS, saveFitScore, savePreferences } from "./fit-write.js";
import type { JobFormQuestion } from "./job-form-schema.js";
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
async function bankAnswer(canonicalId: string, shortText: string): Promise<void> {
  const answerId = randomUUID();
  const content = { canonicalId, shortText, longText: null };
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
  const decisionId = decided.ok ? decided.value[0]?.result : undefined;
  if (!decisionId?.ok) throw new Error("not approved");
  await setClock(new Date(clock.getTime() + UNDO_WINDOW_MS + 60_000));
  const saved = await saveApprovedAnswer(db, {
    candidateId,
    answerId,
    decisionId: decisionId.value.decisionId,
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

// Another job of the same candidate, with its own application at `status` and this form.
async function otherJob(status: string, form: JobFormQuestion[]): Promise<string> {
  const [row] = await db
    .insert(job)
    .values({
      candidateId,
      companyId,
      title: "Other role",
      url: "https://jobs.example.com/other",
      status: "ready",
    })
    .returning({ id: job.id });
  if (!row) throw new Error("no job");
  await db.insert(application).values({ candidateId, jobId: row.id, status });
  await saveJobForm(db, { candidateId, jobId: row.id, ats: "greenhouse", questions: form });
  return row.id;
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
  beforeEach(async () => {
    await saveJobForm(db, { candidateId, jobId, ats: "greenhouse", questions: FORM });
  });
  const seen = async () =>
    (await readPackageInputs(db, candidateId, applicationId))?.formSeenBefore;

  it("is true when another job's current form has this shape and its application went out", async () => {
    await otherJob("submitted", FORM);
    expect(await seen()).toBe(true);
  });

  it("is false when that other application never went out", async () => {
    await otherJob("awaiting_approval", FORM);
    expect(await seen()).toBe(false);
  });

  it("is false when the other job's form has another shape", async () => {
    await otherJob("submitted", [{ ...FORM[0], label: "Why this company?" } as JobFormQuestion]);
    expect(await seen()).toBe(false);
  });

  it("is false when the other job has since moved to another shape", async () => {
    const other = await otherJob("submitted", FORM);
    await saveJobForm(db, {
      candidateId,
      jobId: other,
      ats: "greenhouse",
      questions: [{ ...FORM[0], label: "Changed" } as JobFormQuestion],
    });
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
      .where(eq(domainEvent.type, "application.package_needs_human"));

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
