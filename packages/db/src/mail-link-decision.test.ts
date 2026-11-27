import { CandidateId } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { readInboxThreads } from "./inbox-read.js";
import { mailLinkDecision } from "./mail-link-decision-schema.js";
import { decideQueuedThread, readLinkTargets } from "./mail-link-decision-write.js";
import { listConfirmQueue, readLinkedThreads, recordMailLink } from "./mail-link-write.js";
import { application, domainEvent, job } from "./schema.js";
import { createTestDb, seedApplication, sqlState } from "./test/pglite.js";

// Paul's link or dismiss on a confirm-queue thread (NS-262) on PGlite. Invented Gmail ids only.

const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";
const THREAD = "18c3f0a2b4d6e8aa";
const OTHER_THREAD = "18c3f0a2b4d6e8bb";
const M1 = "18c3f0a2b4d6e801";
const M2 = "18c3f0a2b4d6e802";
const M3 = "18c3f0a2b4d6e803";

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let applicationId: string;
let companyId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const seeded = await seedApplication(db, "submitted");
  candidateId = CandidateId.parse(seeded.candidateId);
  applicationId = seeded.applicationId;
  companyId = seeded.companyId;
});
afterEach(() => close());

// A message matching couldn't place, received on the given day.
const queue = (id: string, day: number, thread = THREAD) =>
  recordMailLink(db, {
    candidateId,
    message: { id, threadId: thread, receivedAt: new Date(Date.UTC(2026, 10, day, 12)) },
    decision: { kind: "queued", reason: "no_match" },
  });

const link = (thread = THREAD, app = applicationId) =>
  decideQueuedThread(db, {
    candidateId,
    gmailThreadId: thread,
    decision: { kind: "link", applicationId: app },
  });
const dismiss = (thread = THREAD) =>
  decideQueuedThread(db, { candidateId, gmailThreadId: thread, decision: { kind: "dismiss" } });

// Another application of the same candidate, in the given status.
async function otherApplication(status: "submitted" | "rejected"): Promise<string> {
  const [j] = await db
    .insert(job)
    .values({ candidateId, companyId, title: "Engineer", url: "https://jobs.example.com/other" })
    .returning({ id: job.id });
  const [a] = await db
    .insert(application)
    .values({ candidateId, jobId: j?.id ?? "", status })
    .returning({ id: application.id });
  return a?.id ?? "";
}

describe("decideQueuedThread", () => {
  it("links every queued message in the thread once, and a repeat or a second choice stores nothing", async () => {
    await queue(M1, 1);
    await queue(M2, 2);
    expect([await link(), await link(), await dismiss()]).toEqual([
      { ok: true, value: { recorded: 2 } },
      { ok: true, value: { recorded: 0 } },
      { ok: true, value: { recorded: 0 } },
    ]);
    const rows = await db.select().from(mailLinkDecision);
    expect(rows.map((r) => [r.gmailMessageId, r.decision, r.applicationId]).sort()).toEqual([
      [M1, "linked", applicationId],
      [M2, "linked", applicationId],
    ]);
  });

  it("decides only the messages queued since, when more mail reaches a decided thread", async () => {
    await queue(M1, 1);
    await dismiss();
    await queue(M2, 2);
    expect(await link()).toEqual({ ok: true, value: { recorded: 1 } });
  });

  it("writes one event per decision, by Paul, with ids and counts only", async () => {
    await queue(M1, 1);
    await queue(M2, 2, OTHER_THREAD);
    await link();
    await dismiss(OTHER_THREAD);
    const events = await db
      .select({
        type: domainEvent.type,
        actor: domainEvent.actor,
        aggregate: domainEvent.aggregate,
        reason: domainEvent.reason,
        payload: domainEvent.payload,
      })
      .from(domainEvent)
      .where(sql`${domainEvent.type} in ('mail.link_confirmed', 'mail.link_dismissed')`)
      .orderBy(domainEvent.position);
    expect(
      events.map((e) => [e.type, e.actor, e.aggregate.split(":")[0], e.reason, e.payload]),
    ).toEqual([
      [
        "mail.link_confirmed",
        "user",
        "application",
        "You linked a job email to this application",
        { gmailThreadId: THREAD, messages: 1, applicationId },
      ],
      [
        "mail.link_dismissed",
        "user",
        "mail_link_decision",
        "You dismissed a job email from the queue",
        { gmailThreadId: OTHER_THREAD, messages: 1 },
      ],
    ]);
  });

  it("refuses a thread with nothing queued, and a closed, unknown or other candidate's application", async () => {
    await queue(M1, 1);
    const closed = await otherApplication("rejected");
    const theirs = (await seedApplication(db, "submitted")).applicationId;
    expect([
      await link(OTHER_THREAD),
      await link(THREAD, closed),
      await link(THREAD, "00000000-0000-4000-8000-000000000000"),
      await link(THREAD, theirs),
      await decideQueuedThread(db, {
        candidateId,
        gmailThreadId: "not-hex",
        decision: { kind: "link", applicationId: "nope" },
      }),
    ]).toEqual([
      { ok: false, error: { kind: "NotFound" } },
      { ok: false, error: { kind: "ApplicationClosed" } },
      { ok: false, error: { kind: "UnknownApplication" } },
      { ok: false, error: { kind: "UnknownApplication" } },
      { ok: false, error: { kind: "InvalidInput", fields: ["gmailThreadId", "applicationId"] } },
    ]);
    expect((await db.select().from(mailLinkDecision)).length).toBe(0);
  });
});

describe("the reads after a decision", () => {
  it("leaves decided messages out of the queue and shows a linked thread under its application", async () => {
    await queue(M1, 1);
    await queue(M2, 2, OTHER_THREAD);
    await queue(M3, 3, "18c3f0a2b4d6e8cc");
    await link();
    await dismiss(OTHER_THREAD);
    const inbox = await readInboxThreads(db, candidateId);
    expect([
      (await listConfirmQueue(db, candidateId)).map((q) => q.gmailMessageId),
      inbox.queued.map((q) => q.gmailThreadId),
      inbox.applications.map((a) => [
        a.applicationId,
        a.threads.map((t) => [t.gmailThreadId, t.step, t.senderVerified, t.messages]),
      ]),
    ]).toEqual([[M3], ["18c3f0a2b4d6e8cc"], [[applicationId, [[THREAD, "paul", false, 1]]]]]);
  });

  it("counts a thread Paul linked for later mail's thread step", async () => {
    await queue(M1, 1);
    await link();
    expect(await readLinkedThreads(db, candidateId)).toEqual(new Map([[applicationId, [THREAD]]]));
  });

  it("offers only the candidate's open applications as link targets", async () => {
    const closed = await otherApplication("rejected");
    await seedApplication(db, "submitted");
    const targets = await readLinkTargets(db, candidateId);
    expect([
      targets.map((t) => [t.applicationId, t.jobTitle, t.company]),
      targets.some((t) => t.applicationId === closed),
    ]).toEqual([[[applicationId, "Backend Engineer", "Example Corp"]], false]);
  });
});

describe("the mail_link_decision table", () => {
  it("refuses UPDATE, DELETE and TRUNCATE", async () => {
    await queue(M1, 1);
    await dismiss();
    expect([
      await sqlState(
        db
          .update(mailLinkDecision)
          .set({ decision: "linked" })
          .where(eq(mailLinkDecision.gmailMessageId, M1)),
      ),
      await sqlState(db.delete(mailLinkDecision)),
      await sqlState(db.execute(sql`truncate mail_link_decision`)),
    ]).toEqual([RESTRICT_VIOLATION, RESTRICT_VIOLATION, RESTRICT_VIOLATION]);
  });

  it("refuses a linked row with no application, a dismissed one with one, and a bad id", async () => {
    const row = { candidateId, gmailMessageId: M1, gmailThreadId: THREAD };
    expect([
      await sqlState(db.insert(mailLinkDecision).values({ ...row, decision: "linked" })),
      await sqlState(
        db.insert(mailLinkDecision).values({ ...row, decision: "dismissed", applicationId }),
      ),
      await sqlState(db.insert(mailLinkDecision).values({ ...row, decision: "maybe" })),
      await sqlState(
        db
          .insert(mailLinkDecision)
          .values({ ...row, gmailMessageId: "Not hex", decision: "dismissed" }),
      ),
    ]).toEqual([CHECK_VIOLATION, CHECK_VIOLATION, CHECK_VIOLATION, CHECK_VIOLATION]);
  });
});
