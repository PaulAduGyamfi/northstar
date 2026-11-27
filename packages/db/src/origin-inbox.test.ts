import { ApplicationId, CandidateId } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { recordMailClassification } from "./mail-classification-write.js";
import { decideQueuedThread } from "./mail-link-decision-write.js";
import { recordMailLink } from "./mail-link-write.js";
import { createApplication, readInboxCreditReport } from "./origin-write.js";
import { job } from "./schema.js";
import { createTestDb, seedApplication } from "./test/pglite.js";
import { transitionApplication } from "./transition-application.js";

// The credit report's inbox stages (NS-248 item 2, INB-010) on PGlite. Synthetic jobs and invented
// Gmail ids only.

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let companyId: string;
let jobs = 0;
let messages = 0;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const seeded = await seedApplication(db, "discovered");
  candidateId = CandidateId.parse(seeded.candidateId);
  companyId = seeded.companyId;
});

afterEach(async () => {
  await close();
});

// An application with the given origin, moved to submitted (by hand) when asked.
async function created(
  startedBy: "northstar" | "outside" | "recruiter_inbound",
  submitted = false,
): Promise<ApplicationId> {
  jobs += 1;
  const [j] = await db
    .insert(job)
    .values({ candidateId, companyId, title: "Engineer", url: `https://jobs.example.com/${jobs}` })
    .returning();
  if (!j) throw new Error("no job");
  const result = await createApplication(db, {
    candidateId,
    jobId: j.id,
    status: "awaiting_approval",
    startedBy,
    idempotencyKey: `create:${jobs}`,
  });
  if (!result.ok) throw new Error(result.error.kind);
  const id = ApplicationId.parse(result.value.applicationId);
  if (submitted) {
    let from = "awaiting_approval";
    for (const to of ["submitting", "submitted"]) {
      const moved = await transitionApplication(db, {
        candidateId,
        applicationId: id,
        from: from as never,
        to: to as never,
        actor: "agent:apply",
        reason: "",
        inputsSummary: "",
        links: [],
        idempotencyKey: `${id}:${to}`,
        submittedVia: "auto",
      });
      if (!moved.ok) throw new Error(moved.error.kind);
      from = to;
    }
  }
  return id;
}

// The report with every stage at 0.
const ZERO = { replied: 0, screen: 0, interview: 0 };
const NOTHING = {
  northstar: ZERO,
  northstar_by_hand: ZERO,
  outside: ZERO,
  recruiter_inbound: ZERO,
  unknown: ZERO,
};

const nextId = () => {
  messages += 1;
  return `18c3f0a2b4d6${String(messages).padStart(4, "0")}`;
};

// A message linked to the application (or queued when none), classified as given.
async function mail(
  applicationId: ApplicationId | null,
  result: { kind: string; stageSignal: string } | { review: true } | null = {
    kind: "info_other",
    stageSignal: "none",
  },
): Promise<string> {
  const id = nextId();
  await recordMailLink(db, {
    candidateId,
    message: { id, threadId: id, receivedAt: new Date(Date.UTC(2026, 10, 1, 12)) },
    decision:
      applicationId === null
        ? { kind: "queued", reason: "no_match" }
        : { kind: "linked", applicationId, step: "tag", senderVerified: true },
  });
  if (result !== null) {
    const stored = await recordMailClassification(db, {
      candidateId,
      gmailMessageId: id,
      result:
        "review" in result
          ? { outcome: "review", reason: "refused", promptVersion: 2 }
          : { outcome: "classified", ...result, decidedBy: "rules" },
    });
    // A refused fixture would make every count look right by accident.
    if (!stored.ok) throw new Error(stored.error.kind);
  }
  return id;
}

describe("readInboxCreditReport", () => {
  it("counts replied, screen and interview per origin, once per application", async () => {
    const a = await created("northstar", true);
    await mail(a, { kind: "assessment", stageSignal: "screen" });
    await mail(a, { kind: "interview_request", stageSignal: "technical" });
    await mail(a, { kind: "scheduling", stageSignal: "onsite" });
    const b = await created("outside");
    await mail(b, { kind: "rejection", stageSignal: "none" });
    await mail(b, { kind: "info_other", stageSignal: "none" });
    const c = await created("recruiter_inbound");
    await mail(c, { kind: "interview_request", stageSignal: "onsite" });
    const report = await readInboxCreditReport(db, candidateId);
    expect(report).toEqual({
      northstar: { replied: 1, screen: 1, interview: 1 },
      northstar_by_hand: { replied: 0, screen: 0, interview: 0 },
      outside: { replied: 1, screen: 0, interview: 0 },
      recruiter_inbound: { replied: 1, screen: 0, interview: 1 },
      unknown: { replied: 0, screen: 0, interview: 0 },
    });
  });

  it("doesn't count a confirmation alone as a reply", async () => {
    const a = await created("northstar");
    await mail(a, { kind: "confirmation", stageSignal: "none" });
    expect((await readInboxCreditReport(db, candidateId)).northstar).toEqual({
      replied: 0,
      screen: 0,
      interview: 0,
    });
  });

  it("counts nothing for a message in review, an unclassified one, a queued one or a dismissed one", async () => {
    const a = await created("outside");
    await mail(a, { review: true });
    await mail(a, null);
    await mail(null, { kind: "rejection", stageSignal: "none" });
    const dismissed = await mail(null, { kind: "offer", stageSignal: "offer" });
    const decided = await decideQueuedThread(db, {
      candidateId,
      gmailThreadId: dismissed,
      decision: { kind: "dismiss" },
    });
    if (!decided.ok) throw new Error(decided.error.kind);
    expect(await readInboxCreditReport(db, candidateId)).toEqual(NOTHING);
  });

  it("counts a message Paul linked from the queue for the application he chose", async () => {
    const a = await created("outside");
    const queued = await mail(null, { kind: "assessment", stageSignal: "screen" });
    const decided = await decideQueuedThread(db, {
      candidateId,
      gmailThreadId: queued,
      decision: { kind: "link", applicationId: a },
    });
    if (!decided.ok) throw new Error(decided.error.kind);
    expect((await readInboxCreditReport(db, candidateId)).outside).toEqual({
      replied: 1,
      screen: 1,
      interview: 0,
    });
  });

  it("leaves out another candidate's mail and applications", async () => {
    const a = await created("northstar");
    await mail(a, { kind: "interview_request", stageSignal: "technical" });
    // Another candidate with its own application (no origin events, so `unknown`) and a reply.
    const other = await seedApplication(db, "submitted");
    const otherId = CandidateId.parse(other.candidateId);
    const id = nextId();
    await recordMailLink(db, {
      candidateId: otherId,
      message: { id, threadId: id, receivedAt: new Date(Date.UTC(2026, 10, 2, 12)) },
      decision: {
        kind: "linked",
        applicationId: other.applicationId,
        step: "tag",
        senderVerified: true,
      },
    });
    const stored = await recordMailClassification(db, {
      candidateId: otherId,
      gmailMessageId: id,
      result: {
        outcome: "classified",
        kind: "assessment",
        stageSignal: "screen",
        decidedBy: "rules",
      },
    });
    if (!stored.ok) throw new Error(stored.error.kind);
    expect([
      await readInboxCreditReport(db, candidateId),
      await readInboxCreditReport(db, otherId),
    ]).toEqual([
      { ...NOTHING, northstar: { replied: 1, screen: 0, interview: 1 } },
      { ...NOTHING, unknown: { replied: 1, screen: 1, interview: 0 } },
    ]);
  });
});
