import { CandidateId, type ReplyPackage, replyContentSha256 } from "@northstar/domain";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approvalEdit, approvalRequest } from "./approval-schema.js";
import {
  decideApprovals,
  editRequest,
  listPendingApprovals,
  requestApproval,
  withdrawApproval,
} from "./approval-write.js";
import type { Db } from "./db.js";
import { replyDraft } from "./reply-schema.js";
import { editReplyDraft, fileReplyDraft, readReplyDraft } from "./reply-write.js";
import { candidate, domainEvent } from "./schema.js";
import { createTestDb, sqlState } from "./test/pglite.js";

// Paul's edit of a waiting reply draft (NS-203 slice 1) on PGlite. Synthetic mail only.

const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";

const exporter = new InMemorySpanExporter();
beforeAll(() => {
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});
afterAll(() => trace.disable());

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;

async function newCandidate(): Promise<CandidateId> {
  const [c] = await db.insert(candidate).values({ displayName: "Test Candidate" }).returning();
  if (!c) throw new Error("no candidate");
  return CandidateId.parse(c.id);
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  candidateId = await newCandidate();
  exporter.reset();
});
afterEach(() => close());

const REPLY: ReplyPackage = {
  gmailMessageId: "18c3f0a2b4d6e8f0",
  threadId: "18c3f0a2b4d6e8aa",
  envelope: {
    to: "jo@acme.example",
    subject: "Re: Your application at Acme",
    inReplyTo: "<m2@acme.example>",
    references: ["<m1@acme.example>", "<m2@acme.example>"],
  },
  replyToOtherDomain: false,
  body: "Hi Jo, thank you for reaching out. I led the billing migration.",
  cites: ["atom-1"],
  followUps: ["Do you want to share your availability?"],
};
const EDITED = "Hi Jo, thanks for reaching out.\nI led the billing migration at my last role.";

async function filed(): Promise<string> {
  const result = await fileReplyDraft(db, { candidateId, reply: REPLY });
  if (!result.ok) throw new Error(result.error.kind);
  return result.value.requestId;
}

const edit = (requestId: string, body = EDITED, who = candidateId) =>
  editReplyDraft(db, { candidateId: who, requestId, body });

const approve = (requestId: string) =>
  decideApprovals(db, { candidateId, requestIds: [requestId], decision: "approve" });

describe("editReplyDraft", () => {
  it("replaces the waiting request with one pinning the edited body, and refuses the old one", async () => {
    const old = await filed();
    const result = await edit(old);
    if (!result.ok) throw new Error(result.error.kind);
    const { requestId } = result.value;
    const draft = await readReplyDraft(db, candidateId, requestId);
    const [request] = await db
      .select()
      .from(approvalRequest)
      .where(eq(approvalRequest.id, requestId));
    expect([
      draft?.body,
      draft?.envelope,
      draft?.cites,
      request?.contentSha256,
      request?.subject,
      (await listPendingApprovals(db, candidateId)).map((p) => p.requestId),
    ]).toEqual([
      EDITED,
      REPLY.envelope,
      REPLY.cites,
      replyContentSha256({ ...REPLY, body: EDITED }),
      (await db.select().from(approvalRequest).where(eq(approvalRequest.id, old)))[0]?.subject,
      [requestId],
    ]);
    const decided = await approve(old);
    if (!decided.ok) throw new Error("no outcomes");
    expect(decided.value[0]?.result).toEqual({ ok: false, error: { kind: "Withdrawn" } });
  });

  it("puts the edit and the approval that follows in the feed, without the body", async () => {
    const old = await filed();
    const result = await edit(old);
    if (!result.ok) throw new Error(result.error.kind);
    await approve(result.value.requestId);
    const events = await db.select().from(domainEvent).orderBy(domainEvent.position);
    expect(events.map((e) => [e.type, e.actor])).toEqual([
      ["approval.requested", "system"],
      ["approval.withdrawn", "user"],
      ["approval.requested", "user"],
      ["approval.decided", "user"],
    ]);
    expect(events[1]?.payload).toMatchObject({ withdrawnBy: "user", edited: true });
    const text = JSON.stringify(events.map((e) => [e.reason, e.payload]));
    expect(text.includes("billing migration") || text.includes(REPLY.envelope.to)).toBe(false);
  });

  it("returns the same request when the same edit is sent again, and stores one draft", async () => {
    const old = await filed();
    const first = await edit(old);
    const again = await edit(old);
    if (!first.ok || !again.ok) throw new Error("not edited");
    expect([again.value.requestId, again.value.replayed]).toEqual([first.value.requestId, true]);
    expect(await db.select().from(replyDraft)).toHaveLength(2);
  });

  it("refuses a different second edit of the same request, and a decided or withdrawn one", async () => {
    const old = await filed();
    await edit(old);
    const decided = await fileReplyDraft(db, {
      candidateId,
      reply: { ...REPLY, gmailMessageId: "18c3f0a2b4d6e801" },
    });
    const withdrawn = await fileReplyDraft(db, {
      candidateId,
      reply: { ...REPLY, gmailMessageId: "18c3f0a2b4d6e802" },
    });
    if (!decided.ok || !withdrawn.ok) throw new Error("not filed");
    await approve(decided.value.requestId);
    await withdrawApproval(db, { candidateId, requestId: withdrawn.value.requestId, by: "user" });
    const before = await db.select().from(approvalRequest);
    expect([
      await edit(old, "Hi Jo, a different edit."),
      await edit(decided.value.requestId),
      await edit(withdrawn.value.requestId),
    ]).toEqual([
      { ok: false, error: { kind: "NotPending" } },
      { ok: false, error: { kind: "NotPending" } },
      { ok: false, error: { kind: "NotPending" } },
    ]);
    expect(await db.select().from(approvalRequest)).toHaveLength(before.length);
  });

  it("refuses an unchanged body, a blank one and one with a hidden character, storing nothing", async () => {
    const old = await filed();
    expect([
      await edit(old, REPLY.body),
      await edit(old, "  \n "),
      await edit(old, "Hi Jo,‮ thanks."),
      await edit(old, "x".repeat(5001)),
    ]).toEqual([
      { ok: false, error: { kind: "ContentUnchanged" } },
      { ok: false, error: { kind: "InvalidRequest", fields: ["body"] } },
      { ok: false, error: { kind: "InvalidRequest", fields: ["body"] } },
      { ok: false, error: { kind: "InvalidRequest", fields: ["body"] } },
    ]);
    expect((await listPendingApprovals(db, candidateId)).map((p) => p.requestId)).toEqual([old]);
  });

  it("turns Windows line breaks into plain ones", async () => {
    const result = await edit(await filed(), "Hi Jo,\r\nthanks.");
    if (!result.ok) throw new Error(result.error.kind);
    expect((await readReplyDraft(db, candidateId, result.value.requestId))?.body).toBe(
      "Hi Jo,\nthanks.",
    );
  });

  it("doesn't find another candidate's request or one that isn't a stored reply", async () => {
    const old = await filed();
    const other = await newCandidate();
    expect([await edit(old, EDITED, other), await edit("not-a-uuid")]).toEqual([
      { ok: false, error: { kind: "NotFound" } },
      { ok: false, error: { kind: "NotFound" } },
    ]);
  });
});

describe("editRequest", () => {
  it("edits only reply requests: an answer or an application package is refused", async () => {
    const filed = (kind: "answer" | "application_package", n: number) =>
      requestApproval(db, {
        candidateId,
        kind,
        subject: `${kind === "answer" ? "answer" : "application"}:00000000-0000-4000-8000-00000000000${n}`,
        contentSha256: "a".repeat(64),
        facts: null,
        actor: "system",
        idempotencyKey: `${kind}-${n}`,
      });
    const answer = await filed("answer", 1);
    const pkg = await filed("application_package", 2);
    if (!answer.ok || !pkg.ok) throw new Error("not filed");
    const editOf = (requestId: string) =>
      editRequest(db, { candidateId, requestId, newContentSha256: "b".repeat(64) });
    expect([await editOf(answer.value.requestId), await editOf(pkg.value.requestId)]).toEqual([
      { ok: false, error: { kind: "NotEditable" } },
      { ok: false, error: { kind: "NotEditable" } },
    ]);
    expect(await listPendingApprovals(db, candidateId)).toHaveLength(2);
  });
});

describe("the approval_edit table", () => {
  it("refuses UPDATE, DELETE and TRUNCATE, and a link from a request Paul didn't withdraw", async () => {
    const old = await filed();
    const result = await edit(old);
    if (!result.ok) throw new Error(result.error.kind);
    const other = await fileReplyDraft(db, {
      candidateId,
      reply: { ...REPLY, gmailMessageId: "18c3f0a2b4d6e803" },
    });
    const third = await fileReplyDraft(db, {
      candidateId,
      reply: { ...REPLY, gmailMessageId: "18c3f0a2b4d6e804" },
    });
    if (!other.ok || !third.ok) throw new Error("not filed");
    expect([
      await sqlState(db.update(approvalEdit).set({ editedAt: new Date() })),
      await sqlState(db.delete(approvalEdit)),
      await sqlState(db.execute(sql`truncate approval_edit`)),
      await sqlState(
        db.insert(approvalEdit).values({
          candidateId,
          previousRequestId: other.value.requestId,
          requestId: third.value.requestId,
          editedAt: new Date(),
        }),
      ),
    ]).toEqual([RESTRICT_VIOLATION, RESTRICT_VIOLATION, RESTRICT_VIOLATION, CHECK_VIOLATION]);
  });
});
