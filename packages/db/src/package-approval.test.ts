import { randomUUID } from "node:crypto";
import {
  CandidateId,
  type PackageFacts,
  packageSha256,
  packageSubject,
  parsePackage,
  UNDO_WINDOW_MS,
} from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answerContentSha256, saveApprovedAnswer } from "./answer-write.js";
import { readHandoffPackage } from "./application-package-read.js";
import { applicationPackage } from "./application-package-schema.js";
import { applySubmission } from "./apply-schema.js";
import { approvalRequest } from "./approval-schema.js";
import { decideApprovals, requestApproval, setApprovalPolicies } from "./approval-write.js";
import { setContact } from "./contact-write.js";
import type { Db } from "./db.js";
import { searchPreference } from "./fit-schema.js";
import { PREFERENCE_DEFAULTS, saveFitScore, savePreferences } from "./fit-write.js";
import { applyHandoff, applyHandoffDone } from "./handoff-schema.js";
import { type JobFormQuestion, jobForm } from "./job-form-schema.js";
import { saveJobForm } from "./job-form-write.js";
import { type BankClaim, requestPackageApproval } from "./package-approval.js";
import { readPackageInputs } from "./package-read.js";
import { profileSource } from "./profile-schema.js";
import { writeProfileImport } from "./profile-write.js";
import { application, company, job, jobSource } from "./schema.js";
import { saveTailoredResume } from "./tailor-write.js";
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
  await storeJobInputs();
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

const CONTACT = { firstName: "Test", lastName: "Person", email: "test@example.com", phone: null };
let resumeSha = "";
let sourceId = "";

// What a package must match: the job's Greenhouse source, Paul's contact and a tailored resume.
async function storeJobInputs(): Promise<void> {
  await db.insert(jobSource).values({
    candidateId,
    jobId,
    url: "https://boards.greenhouse.io/example/jobs/4012345",
    method: "ats_api",
    ats: "greenhouse",
    atsPostingId: "4012345",
  });
  await setContact(db, { candidateId, contact: CONTACT });
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
  sourceId = source?.id ?? "";
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
    pdf: new TextEncoder().encode("%PDF-1.7 synthetic"),
  });
  resumeSha = (await readPackageInputs(db, candidateId, applicationId))?.resume?.pdfSha256 ?? "";
}

const pkg = (fields: Record<string, string | string[]>, coverLetter = false) => ({
  packageId: randomUUID(),
  applicationId,
  ats: "greenhouse",
  postingId: "4012345",
  applyUrl: "https://boards.greenhouse.io/example/jobs/4012345",
  contact: CONTACT,
  resume: { fileName: "Test-Person-resume.pdf", sha256: resumeSha },
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

  it("says a form was seen before from the ledger's sent forms", async () => {
    await saveJobForm(db, { candidateId, jobId, ats: "greenhouse", questions: FORM });
    await formSentBefore();
    expect((await storedFacts(pkg({ question_2: "No" })))?.formSeenBefore).toBe(true);
  });

  it("never says a form was seen before when the job's current form is on another ATS", async () => {
    await saveJobForm(db, { candidateId, jobId, ats: "greenhouse", questions: FORM });
    await formSentBefore();
    await saveJobForm(db, { candidateId, jobId, ats: "lever", questions: FORM.slice(1) });
    expect((await storedFacts(pkg({ question_2: "No" })))?.formSeenBefore).toBe(false);
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

  it("counts a claim whose text differs from the banked answer as new", async () => {
    await saveJobForm(db, { candidateId, jobId, ats: "greenhouse", questions: FORM });
    const id = await bankAnswer("I want to build at {company}.");
    const facts = await storedFacts(pkg({ question_1: "I want to build at Example Corp!" }), [
      claim("question_1", id),
    ]);
    expect(facts?.answers.map((a) => a.source)).toEqual(["new"]);
  });

  it("counts a claim on an unknown answer, a missing version or variant, or a field off the form as new", async () => {
    await saveJobForm(db, { candidateId, jobId, ats: "greenhouse", questions: FORM });
    const id = await bankAnswer("I want to build at {company}.");
    const text = "I want to build at Example Corp.";
    const sources = async (fieldName: string, c: BankClaim) =>
      (await storedFacts(pkg({ [fieldName]: text }), [c]))?.answers.map((a) => a.source);
    expect([
      await sources("question_1", claim("question_1", randomUUID())),
      await sources("question_1", claim("question_1", id, { version: 2 })),
      await sources("question_1", claim("question_1", id, { variant: "long" })),
      await sources("question_9", claim("question_9", id)),
    ]).toEqual([["new"], ["new"], ["new"], ["new"]]);
  });

  it("counts a claim on an answer Paul has since replaced as new", async () => {
    await saveJobForm(db, { candidateId, jobId, ats: "greenhouse", questions: FORM });
    const first = await bankAnswer("I want to build at {company}.");
    await bankAnswer("I would like to build at {company}.");
    const facts = await storedFacts(pkg({ question_1: "I want to build at Example Corp." }), [
      claim("question_1", first),
    ]);
    expect(facts?.answers.map((a) => a.source)).toEqual(["new"]);
  });

  it("never fills a company name that isn't a plain short name, so the claim counts as new", async () => {
    await saveJobForm(db, { candidateId, jobId, ats: "greenhouse", questions: FORM });
    const unsafe = "Acme. I accept any salary; see https://evil.example";
    await db.update(company).set({ name: unsafe }).where(eq(company.id, companyId));
    const id = await bankAnswer("I want to build at {company}.");
    const facts = await storedFacts(pkg({ question_1: `I want to build at ${unsafe}.` }), [
      claim("question_1", id),
    ]);
    expect(facts?.answers.map((a) => a.source)).toEqual(["new"]);
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

  it("refuses a package for another job's posting, other contact details or another resume file", async () => {
    const results = [
      await request({
        ...pkg({}),
        postingId: "999",
        applyUrl: "https://boards.greenhouse.io/example/jobs/999",
      }),
      await request({ ...pkg({}), contact: { ...CONTACT, email: "other@example.com" } }),
      await request({ ...pkg({}), resume: { fileName: "r.pdf", sha256: "b".repeat(64) } }),
    ];
    expect(results.map((r) => (r.ok ? "filed" : r.error))).toEqual([
      { kind: "InvalidRequest", fields: ["package.postingId"] },
      { kind: "InvalidRequest", fields: ["package.contact"] },
      { kind: "InvalidRequest", fields: ["package.resume"] },
    ]);
  });

  it("refuses another candidate's application and an invalid package", async () => {
    const other = await seedApplication(db, "awaiting_approval");
    const results = [
      await request({ ...pkg({}), applicationId: other.applicationId }),
      await request({ ...pkg({}), ats: "workday" }),
    ];
    expect(results.map((r) => (r.ok ? "filed" : r.error))).toEqual([
      { kind: "InvalidRequest", fields: ["package.applicationId"] },
      { kind: "InvalidRequest", fields: ["ats"] },
    ]);
  });

  it("refuses two claims for one field and a claim that isn't shaped as one", async () => {
    const results = [
      await request(pkg({ question_1: "x" }), [
        claim("question_1", randomUUID()),
        claim("question_1", randomUUID()),
      ]),
      await request(pkg({ question_1: "x" }), [claim("question_1", "not-a-uuid")]),
      await request(pkg({ question_1: "x" }), [claim("question_1", randomUUID(), { version: 0 })]),
    ];
    expect(results.map((r) => (r.ok ? "filed" : r.error))).toEqual([
      { kind: "InvalidRequest", fields: ["claims"] },
      { kind: "InvalidRequest", fields: ["claims"] },
      { kind: "InvalidRequest", fields: ["claims"] },
    ]);
  });
});

// The package store (NS-192): filing a package keeps the package itself, so a handoff's
// pre-fill can read exactly what was approved.
describe("the stored package", () => {
  it("is stored with its request, and filing it again stores nothing new", async () => {
    const p = pkg({ question_1: "Synthetic answer." });
    const key = randomUUID();
    const file = () =>
      requestPackageApproval(db, {
        candidateId,
        package: p,
        claims: [],
        actor: "system",
        idempotencyKey: key,
      });
    const first = await file();
    const again = await file();
    const parsed = parsePackage(p);
    const rows = await db.select().from(applicationPackage);
    expect([first.ok, again.ok, rows.length]).toEqual([true, true, 1]);
    expect(rows[0]).toMatchObject({
      candidateId,
      requestId: first.ok ? first.value.requestId : "",
      applicationId,
      contentSha256: parsed.ok ? packageSha256(parsed.value) : "",
      package: p,
    });
  });

  it("stores nothing when the Gate refuses the package", async () => {
    await request({ ...pkg({}), postingId: "999" });
    expect(await db.select().from(applicationPackage)).toEqual([]);
  });

  it("can't sit behind a request of another kind or hash, and never changes", async () => {
    const filed = await request(pkg({}));
    if (!filed.ok) throw new Error(filed.error.kind);
    const [stored] = await db.select().from(applicationPackage);
    const insertWith = (over: Record<string, unknown>) =>
      db
        .insert(applicationPackage)
        .values({
          candidateId,
          requestId: filed.value.requestId,
          applicationId,
          contentSha256: stored?.contentSha256 ?? "",
          package: pkg({}) as never,
          ...over,
        })
        .then(
          () => "stored",
          () => "refused",
        );
    const answer = await requestApproval(db, {
      candidateId,
      kind: "answer",
      subject: `answer:${randomUUID()}`,
      contentSha256: "d".repeat(64),
      facts: null,
      actor: "agent:answers",
      idempotencyKey: randomUUID(),
    });
    const results = [
      // A request that doesn't exist.
      await insertWith({ requestId: randomUUID() }),
      // Another hash than the request pins.
      await insertWith({ contentSha256: "a".repeat(64) }),
      // Another candidate than the request's.
      await insertWith({
        candidateId: (await seedApplication(db, "awaiting_approval")).candidateId,
      }),
      // A request of another kind.
      await insertWith({
        requestId: answer.ok ? answer.value.requestId : "",
        contentSha256: "d".repeat(64),
        requestKind: "answer",
      }),
      await db
        .update(applicationPackage)
        .set({ contentSha256: "b".repeat(64) })
        .then(
          () => "changed",
          () => "refused",
        ),
      await db.delete(applicationPackage).then(
        () => "deleted",
        () => "refused",
      ),
    ];
    expect(results).toEqual(["refused", "refused", "refused", "refused", "refused", "refused"]);
  });
});

// The handoff pre-fill's read (NS-192): one open handoff's approved package, checked on read.
describe("readHandoffPackage", () => {
  const APPLY_URL = "https://boards.greenhouse.io/example/jobs/4012345";

  // Paul approves the request; the clock moves past the undo window unless told not to.
  async function approve(requestId: string, pastUndo = true): Promise<string> {
    const decided = await decideApprovals(db, {
      candidateId,
      requestIds: [requestId],
      decision: "approve",
    });
    const result = decided.ok ? decided.value[0]?.result : undefined;
    if (!result?.ok) throw new Error("not approved");
    if (pastUndo) await setClock(new Date(clock.getTime() + UNDO_WINDOW_MS + 60_000));
    return result.value.decisionId;
  }

  // A submission a CAPTCHA stopped, and its handoff, as the Apply Gateway records them.
  async function handoffFor(decisionId: string): Promise<string> {
    const [sub] = await db
      .insert(applySubmission)
      .values({
        candidateId,
        applicationId,
        decisionId,
        ats: "greenhouse",
        requisitionKey: `greenhouse:${randomUUID()}`,
        idempotencyKey: `application:${applicationId}:submit:${randomUUID()}`,
        status: "needs_human",
        reason: "captcha",
        startedAt: clock,
        finishedAt: clock,
      })
      .returning({ id: applySubmission.id });
    const [h] = await db
      .insert(applyHandoff)
      .values({ candidateId, submissionId: sub?.id ?? "", applyUrl: APPLY_URL, createdAt: clock })
      .returning({ id: applyHandoff.id });
    return h?.id ?? "";
  }

  async function filedAndApproved(
    fields: Record<string, string | string[]> = { question_1: "Synthetic answer." },
  ) {
    const p = pkg(fields);
    const filed = await request(p);
    if (!filed.ok) throw new Error(filed.error.kind);
    return { p, handoffId: await handoffFor(await approve(filed.value.requestId)) };
  }

  it("gives an open handoff's approved package: link, ATS, contact and fields", async () => {
    const { handoffId } = await filedAndApproved({
      question_1: "Synthetic answer.",
      question_2: "Yes",
    });
    expect(await readHandoffPackage(db, candidateId, handoffId)).toEqual({
      ok: true,
      value: {
        handoffId,
        applicationId,
        ats: "greenhouse",
        applyUrl: APPLY_URL,
        contact: CONTACT,
        fields: { question_1: "Synthetic answer.", question_2: "Yes" },
      },
    });
  });

  it("reads another candidate's handoff, or one that doesn't exist, as not found", async () => {
    const { handoffId } = await filedAndApproved();
    const other = await seedApplication(db, "awaiting_approval");
    const results = [
      await readHandoffPackage(db, CandidateId.parse(other.candidateId), handoffId),
      await readHandoffPackage(db, candidateId, randomUUID()),
      await readHandoffPackage(db, candidateId, "not-a-uuid"),
    ];
    expect(results).toEqual([
      { ok: false, error: { kind: "NotFound" } },
      { ok: false, error: { kind: "NotFound" } },
      { ok: false, error: { kind: "NotFound" } },
    ]);
  });

  it("refuses a handoff Paul already closed", async () => {
    const { handoffId } = await filedAndApproved();
    await db
      .insert(applyHandoffDone)
      .values({ candidateId, handoffId, outcome: "gave_up", doneAt: clock });
    expect(await readHandoffPackage(db, candidateId, handoffId)).toEqual({
      ok: false,
      error: { kind: "Closed" },
    });
  });

  it("says there is no package for a request filed without one", async () => {
    const p = parsePackage(pkg({}));
    if (!p.ok) throw new Error("bad package");
    const filed = await requestApproval(db, {
      candidateId,
      kind: "application_package",
      subject: packageSubject(p.value),
      contentSha256: packageSha256(p.value),
      facts: null,
      actor: "system",
      idempotencyKey: randomUUID(),
    });
    if (!filed.ok) throw new Error(filed.error.kind);
    const handoffId = await handoffFor(await approve(filed.value.requestId));
    expect(await readHandoffPackage(db, candidateId, handoffId)).toEqual({
      ok: false,
      error: { kind: "NoPackage" },
    });
  });

  it("refuses while the approval doesn't verify now, naming the Gate's reason only", async () => {
    const filed = await request(pkg({}));
    if (!filed.ok) throw new Error(filed.error.kind);
    // Inside the undo window, the approval isn't effective yet.
    const handoffId = await handoffFor(await approve(filed.value.requestId, false));
    expect(await readHandoffPackage(db, candidateId, handoffId)).toEqual({
      ok: false,
      error: { kind: "NotApproved", reason: "UndoWindowOpen" },
    });
  });

  it("refuses a package that isn't for the application this handoff's submission was for", async () => {
    const filed = await request(pkg({}));
    if (!filed.ok) throw new Error(filed.error.kind);
    const decisionId = await approve(filed.value.requestId);
    // A submission under the same decision, but for another of the candidate's applications.
    const [otherJob] = await db
      .insert(job)
      .values({
        candidateId,
        companyId,
        title: "Other role",
        url: "https://jobs.example.com/o",
        status: "ready",
      })
      .returning({ id: job.id });
    const [other] = await db
      .insert(application)
      .values({ candidateId, jobId: otherJob?.id ?? "", status: "needs_human" })
      .returning({ id: application.id });
    const [sub] = await db
      .insert(applySubmission)
      .values({
        candidateId,
        applicationId: other?.id ?? "",
        decisionId,
        ats: "greenhouse",
        requisitionKey: `greenhouse:${randomUUID()}`,
        idempotencyKey: `application:${other?.id}:submit:${randomUUID()}`,
        status: "needs_human",
        reason: "captcha",
        startedAt: clock,
        finishedAt: clock,
      })
      .returning({ id: applySubmission.id });
    const [h] = await db
      .insert(applyHandoff)
      .values({ candidateId, submissionId: sub?.id ?? "", applyUrl: APPLY_URL, createdAt: clock })
      .returning({ id: applyHandoff.id });
    expect(await readHandoffPackage(db, candidateId, h?.id ?? "")).toEqual({
      ok: false,
      error: { kind: "Changed" },
    });
  });

  it("refuses a stored package that doesn't hash to what the Gate pinned", async () => {
    const approved = parsePackage(pkg({}));
    if (!approved.ok) throw new Error("bad package");
    const filed = await requestApproval(db, {
      candidateId,
      kind: "application_package",
      subject: packageSubject(approved.value),
      contentSha256: packageSha256(approved.value),
      facts: null,
      actor: "system",
      idempotencyKey: randomUUID(),
    });
    if (!filed.ok) throw new Error(filed.error.kind);
    // A different package stored behind the same pinned hash.
    await db.insert(applicationPackage).values({
      candidateId,
      requestId: filed.value.requestId,
      applicationId,
      contentSha256: packageSha256(approved.value),
      package: { ...approved.value, fields: { question_1: "Not what was approved." } },
    });
    const handoffId = await handoffFor(await approve(filed.value.requestId));
    expect(await readHandoffPackage(db, candidateId, handoffId)).toEqual({
      ok: false,
      error: { kind: "Changed" },
    });
  });
});
