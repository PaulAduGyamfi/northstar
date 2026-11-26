import { randomUUID } from "node:crypto";
import { CandidateId, type PackageFacts, UNDO_WINDOW_MS } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answerContentSha256, saveApprovedAnswer } from "./answer-write.js";
import { applySubmission } from "./apply-schema.js";
import { approvalRequest } from "./approval-schema.js";
import { decideApprovals, requestApproval, setApprovalPolicies } from "./approval-write.js";
import type { Db } from "./db.js";
import { searchPreference } from "./fit-schema.js";
import { PREFERENCE_DEFAULTS, saveFitScore, savePreferences } from "./fit-write.js";
import { type JobFormQuestion, jobForm } from "./job-form-schema.js";
import { saveJobForm } from "./job-form-write.js";
import { type BankClaim, requestPackageApproval } from "./package-approval.js";
import { readPackageInputs } from "./package-read.js";
import { profileSource } from "./profile-schema.js";
import { writeProfileImport } from "./profile-write.js";
import { application, job } from "./schema.js";
import { createTestDb, seedApplication } from "./test/pglite.js";

// The Gate derives an application package's policy facts itself (NS-213 slice 1). Synthetic data
// only; the seeded company is "Example Corp".

const NOW = new Date("2026-11-25T12:00:00Z");

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let applicationId: string;
let jobId: string;
let companyId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const seeded = await seedApplication(db, "awaiting_approval");
  candidateId = CandidateId.parse(seeded.candidateId);
  applicationId = seeded.applicationId;
  jobId = seeded.jobId;
  companyId = seeded.companyId;
  await setClock(NOW);
});
afterEach(() => close());

let clock = NOW;
async function setClock(at: Date): Promise<void> {
  clock = at;
  await db.execute(sql`select set_config('northstar.gate_test_now', ${at.toISOString()}, false)`);
}

// A textarea and a choice, as the Greenhouse reader stores them.
const FORM: JobFormQuestion[] = [
  {
    fieldName: "question_1",
    label: "Why us?",
    required: true,
    kind: "textarea",
    choices: null,
    group: 0,
  },
  {
    fieldName: "question_2",
    label: "Are you willing to relocate?",
    required: true,
    kind: "select",
    choices: [
      { label: "Yes", value: "1" },
      { label: "No", value: "0" },
    ],
    group: 1,
  },
];

const pkg = (fields: Record<string, string | string[]>, coverLetter = false) => ({
  packageId: randomUUID(),
  applicationId,
  ats: "greenhouse",
  postingId: "4012345",
  applyUrl: "https://boards.greenhouse.io/example/jobs/4012345",
  contact: { firstName: "Test", lastName: "Person", email: "test@example.com", phone: null },
  resume: { fileName: "resume.pdf", sha256: "b".repeat(64) },
  coverLetter: coverLetter ? { fileName: "cover.pdf", sha256: "c".repeat(64) } : null,
  fields,
});

const request = (p: unknown, claims: BankClaim[] = []) =>
  requestPackageApproval(db, {
    candidateId,
    package: p,
    claims,
    actor: "system",
    idempotencyKey: randomUUID(),
  });

// The facts stored with the request: what Paul's policies were run on.
async function storedFacts(p: unknown, claims: BankClaim[] = []): Promise<PackageFacts | null> {
  const filed = await request(p, claims);
  if (!filed.ok) throw new Error(filed.error.kind);
  const [row] = await db
    .select({ facts: approvalRequest.facts })
    .from(approvalRequest)
    .where(eq(approvalRequest.id, filed.value.requestId));
  return row?.facts ?? null;
}

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

// One banked answer (version 1), approved through the Gate as the answer bank does.
async function bankAnswer(shortText: string, longText: string | null = null): Promise<string> {
  const answerId = randomUUID();
  const content: AnswerDraft = { canonicalId: "why-this-company", shortText, longText };
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
  return answerId;
}

const claim = (fieldName: string, answerId: string, over: Partial<BankClaim> = {}): BankClaim => ({
  fieldName,
  answerId,
  version: 1,
  variant: "short",
  source: "bank_exact",
  ...over,
});

async function scoreJob(score: number): Promise<void> {
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
  const [source] = await db.select({ id: profileSource.id }).from(profileSource);
  await savePreferences(db, { candidateId, values: PREFERENCE_DEFAULTS, now: NOW });
  const [pref] = await db.select({ id: searchPreference.id }).from(searchPreference);
  await saveFitScore(db, {
    candidateId,
    now: NOW,
    jobId,
    preferenceId: pref?.id ?? "",
    preferenceVersion: 1,
    profileSourceId: source?.id ?? "",
    jobFingerprint: "f".repeat(64),
    score,
    band: "queue",
    reason: "ok",
    stretch: false,
    components: {},
    evidence: {},
  });
}

// This job's form shape went out through the Apply Gateway on another job (APPLY-003).
async function formSentBefore(): Promise<void> {
  const sha256 = (await readPackageInputs(db, candidateId, applicationId))?.form?.sha256 ?? "";
  const [other] = await db
    .insert(job)
    .values({
      candidateId,
      companyId,
      title: "Other role",
      url: "https://jobs.example.com/o",
      status: "ready",
    })
    .returning({ id: job.id });
  const [app] = await db
    .insert(application)
    .values({ candidateId, jobId: other?.id ?? "", status: "submitted" })
    .returning({ id: application.id });
  await db.insert(jobForm).values({
    candidateId,
    jobId: other?.id ?? "",
    ats: "greenhouse",
    sha256,
    questions: FORM,
    readAt: new Date(NOW.getTime() - 3_600_000),
  });
  const decisionId = await approvedDecision(randomUUID(), {
    canonicalId: "why-this-role",
    shortText: "A synthetic answer.",
    longText: null,
  });
  await db.insert(applySubmission).values({
    candidateId,
    applicationId: app?.id ?? "",
    decisionId,
    ats: "greenhouse",
    requisitionKey: `greenhouse:${randomUUID()}`,
    idempotencyKey: `application:${app?.id}:submit`,
    status: "submitted",
    reason: null,
    startedAt: new Date(NOW.getTime() - 60_000),
    finishedAt: NOW,
  });
}

describe("requestPackageApproval", () => {
  it("takes fit, form seen before and word counts from storage, and counts a cover letter as new", async () => {
    await scoreJob(82);
    await saveJobForm(db, { candidateId, jobId, ats: "greenhouse", questions: FORM });
    expect(
      await storedFacts(pkg({ question_1: "I like small teams", question_2: "Yes" }, true)),
    ).toEqual({
      fit: 82,
      adapter: "known",
      formSeenBefore: false,
      answers: [
        { source: "new", freeTextWords: 0 },
        { source: "new", freeTextWords: 4 },
        { source: "new", freeTextWords: 0 },
      ],
    });
  });

  it("says a form was seen before only from the ledger, and only on the package's own ATS", async () => {
    await saveJobForm(db, { candidateId, jobId, ats: "greenhouse", questions: FORM });
    await formSentBefore();
    const seen = await storedFacts(pkg({ question_2: "No" }));
    const lever = await storedFacts({ ...pkg({ question_2: "No" }), ats: "lever" });
    expect([seen?.formSeenBefore, lever?.formSeenBefore, seen?.fit]).toEqual([true, false, null]);
  });

  it("keeps a bank claim when the field holds Paul's approved text with the company filled in", async () => {
    await saveJobForm(db, { candidateId, jobId, ats: "greenhouse", questions: FORM });
    const id = await bankAnswer(
      "I want to build at {company}.",
      "I want to build at {company}, for a long time.",
    );
    const facts = await storedFacts(
      pkg({ question_1: "I want to build at Example Corp, for a long time." }),
      [claim("question_1", id, { variant: "long", source: "bank_high_confidence" })],
    );
    expect(facts?.answers).toEqual([{ source: "bank_high_confidence", freeTextWords: 11 }]);
  });

  it("counts a claim as new when the text differs, the answer or version is unknown, or the form lacks the field", async () => {
    await saveJobForm(db, { candidateId, jobId, ats: "greenhouse", questions: FORM });
    const id = await bankAnswer("I want to build at {company}.");
    const facts = await storedFacts(
      pkg({
        question_1: "I want to build at Example Corp!",
        question_2: "Yes",
        question_9: "I want to build at Example Corp.",
      }),
      [claim("question_1", id), claim("question_2", randomUUID()), claim("question_9", id)],
    );
    const version = await storedFacts(pkg({ question_1: "I want to build at Example Corp." }), [
      claim("question_1", id, { version: 2 }),
    ]);
    const long = await storedFacts(pkg({ question_1: "I want to build at Example Corp." }), [
      claim("question_1", id, { variant: "long" }),
    ]);
    expect([
      facts?.answers.map((a) => a.source),
      version?.answers.map((a) => a.source),
      long?.answers.map((a) => a.source),
    ]).toEqual([["new", "new", "new"], ["new"], ["new"]]);
  });

  it("never verifies a claim with a slot other than the company, or a picked list", async () => {
    await saveJobForm(db, { candidateId, jobId, ats: "greenhouse", questions: FORM });
    const slot = await bankAnswer("I admire {team}.");
    const facts = await storedFacts(
      pkg({ question_1: "I admire Example Corp.", question_2: ["Yes"] }),
      [claim("question_1", slot), claim("question_2", slot)],
    );
    expect(facts?.answers).toEqual([
      { source: "new", freeTextWords: 4 },
      { source: "new", freeTextWords: 0 },
    ]);
  });

  it("auto-approves only on facts the Gate read: a seen form, a stored fit and Paul's own text", async () => {
    await setApprovalPolicies(db, {
      candidateId,
      rules: [
        {
          name: "reuse",
          kind: "application_package",
          minFit: 70,
          allowHighConfidenceAnswers: false,
          maxFreeTextWords: 50,
        },
      ],
    });
    await saveJobForm(db, { candidateId, jobId, ats: "greenhouse", questions: FORM });
    const id = await bankAnswer("I want to build at {company}.");
    const fields = { question_1: "I want to build at Example Corp." };
    const unscored = await request(pkg(fields), [claim("question_1", id)]);
    await scoreJob(82);
    const unseen = await request(pkg(fields), [claim("question_1", id)]);
    await formSentBefore();
    const approved = await request(pkg(fields), [claim("question_1", id)]);
    expect(
      [unscored, unseen, approved].map((r) => (r.ok ? r.value.outcome : r.error.kind)),
    ).toEqual([
      { auto: false, why: [{ rule: "reuse", failed: ["fit", "form_seen_before"] }] },
      { auto: false, why: [{ rule: "reuse", failed: ["form_seen_before"] }] },
      { auto: true, rule: "reuse" },
    ]);
  });

  it("refuses another candidate's application, an invalid package and two claims for one field", async () => {
    const other = await seedApplication(db, "awaiting_approval");
    const results = [
      await request({ ...pkg({}), applicationId: other.applicationId }),
      await request({ ...pkg({}), ats: "workday" }),
      await request(pkg({ question_1: "x" }), [
        claim("question_1", randomUUID()),
        claim("question_1", randomUUID()),
      ]),
    ];
    expect(results.map((r) => (r.ok ? "filed" : r.error))).toEqual([
      { kind: "InvalidRequest", fields: ["package.applicationId"] },
      { kind: "InvalidRequest", fields: ["ats"] },
      { kind: "InvalidRequest", fields: ["claims"] },
    ]);
  });
});
