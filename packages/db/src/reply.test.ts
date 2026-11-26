import {
  CandidateId,
  type ReplyPackage,
  replyContentSha256,
  replySubject,
} from "@northstar/domain";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approvalRequest } from "./approval-schema.js";
import { listPendingApprovals } from "./approval-write.js";
import type { Db } from "./db.js";
import { replyDraft } from "./reply-schema.js";
import { fileReplyDraft, readReplyDraft } from "./reply-write.js";
import { candidate, domainEvent } from "./schema.js";
import { createTestDb, sqlState } from "./test/pglite.js";

// Filing a checked reply draft with the Gate (NS-237 slice 1) on PGlite. Synthetic mail only.

const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";

const exporter = new InMemorySpanExporter();
beforeAll(() => {
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});
afterAll(() => {
  trace.disable();
});

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
  body: "Hi Jo, thank you for reaching out. I led the billing migration.",
  cites: ["atom-1"],
  followUps: ["Do you want to share your availability?"],
};

const file = (reply: unknown = REPLY, who = candidateId) =>
  fileReplyDraft(db, { candidateId: who, reply });

describe("fileReplyDraft", () => {
  it("files the draft with the Gate as a pending reply and stores what Paul approves", async () => {
    const filed = await file();
    if (!filed.ok) throw new Error(filed.error.kind);
    const [request] = await db.select().from(approvalRequest);
    expect([
      filed.value.stored,
      filed.value.decision,
      (await listPendingApprovals(db, candidateId)).map((p) => [p.kind, p.subject]),
      [request?.contentSha256, request?.facts],
      await readReplyDraft(db, candidateId, filed.value.requestId),
    ]).toEqual([
      true,
      null,
      [["email_reply", replySubject("18c3f0a2b4d6e8f0")]],
      [replyContentSha256(REPLY), null],
      {
        requestId: filed.value.requestId,
        gmailMessageId: REPLY.gmailMessageId,
        threadId: REPLY.threadId,
        envelope: REPLY.envelope,
        body: REPLY.body,
        cites: REPLY.cites,
        followUps: REPLY.followUps,
        contentSha256: replyContentSha256(REPLY),
      },
    ]);
  });

  it("replays the same draft and stores nothing new", async () => {
    const first = await file();
    const again = await file();
    const rows = await db.select({ id: replyDraft.id }).from(replyDraft);
    expect([
      first.ok && again.ok && first.value.requestId === again.value.requestId,
      again.ok && [again.value.replayed, again.value.stored],
      rows.length,
    ]).toEqual([true, [true, false], 1]);
  });

  it("refuses a different draft for a message whose reply still waits for Paul", async () => {
    await file();
    expect(await file({ ...REPLY, body: "Hi Jo, a different reply." })).toEqual({
      ok: false,
      error: { kind: "SubjectAlreadyRequested" },
    });
  });

  it("refuses a draft that isn't shaped as one, naming the fields, and files nothing", async () => {
    const refused = await file({
      ...REPLY,
      envelope: { ...REPLY.envelope, subject: "Re: x\r\nBcc: other@evil.example" },
    });
    expect([refused, (await db.select().from(approvalRequest)).length]).toEqual([
      { ok: false, error: { kind: "InvalidRequest", fields: ["envelope.subject"] } },
      0,
    ]);
  });

  it("reads no other candidate's draft", async () => {
    const filed = await file();
    const other = await newCandidate();
    expect(filed.ok && (await readReplyDraft(db, other, filed.value.requestId))).toBeNull();
  });

  it("puts no body, recipient or subject in any event or span", async () => {
    await file();
    const events = await db.select().from(domainEvent);
    const text = JSON.stringify(
      [events, exporter.getFinishedSpans().map((s) => [s.name, s.attributes, s.events])],
      (_k, v) => (typeof v === "bigint" ? String(v) : v),
    );
    expect([
      events.map((e) => e.type),
      exporter.getFinishedSpans().length > 0,
      /jo@acme|billing migration|Your application at Acme|availability/.test(text),
    ]).toEqual([["approval.requested"], true, false]);
  });

  it("keeps drafts append-only, and refuses a header with a line break in the database too", async () => {
    const filed = await file();
    if (!filed.ok) throw new Error(filed.error.kind);
    const [row] = await db.select().from(replyDraft);
    const { id: _id, createdAt: _at, ...copy } = row ?? ({} as typeof replyDraft.$inferSelect);
    expect([
      await sqlState(db.update(replyDraft).set({ body: "Changed" })),
      await sqlState(db.delete(replyDraft)),
      await sqlState(db.execute(sql`truncate reply_draft`)),
      await sqlState(
        db
          .insert(replyDraft)
          .values({ ...copy, subject: "Re: x\nBcc: y", requestId: filed.value.requestId }),
      ),
    ]).toEqual([RESTRICT_VIOLATION, RESTRICT_VIOLATION, RESTRICT_VIOLATION, CHECK_VIOLATION]);
  });
});
