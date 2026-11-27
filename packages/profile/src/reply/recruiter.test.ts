import { type Db, fileReplyDraft, readReplyDraft, schema } from "@northstar/db";
import { createTestDb } from "@northstar/db/testing";
import { CandidateId } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RECRUITER_REPLY_SENTENCES,
  recruiterReplyBody,
  recruiterReplyKind,
  recruiterReplyPackage,
} from "./recruiter.js";
import { isCommitmentWord } from "./validate.js";

// A reply by recruiter grade as the Gate's reply package (NS-238 slice 2). Synthetic mail only.

const INBOUND = {
  from: "Jo Recruiter <jo@acme.example>",
  replyTo: null,
  subject: "Senior engineer role at Acme",
  messageId: "<r2@acme.example>",
  references: "<r1@acme.example>",
};

const reply = (over: Partial<Parameters<typeof recruiterReplyPackage>[0]> = {}) =>
  recruiterReplyPackage({
    gmailMessageId: "18c3f0a2b4d6e8f1",
    threadId: "18c3f0a2b4d6e8ab",
    inbound: INBOUND,
    grade: "B",
    ...over,
  });

describe("recruiterReplyKind", () => {
  it("maps A and B to interested, C to more info, D to decline and F to archive", () => {
    expect((["A", "B", "C", "D", "F"] as const).map(recruiterReplyKind)).toEqual([
      "interested",
      "interested",
      "more_info",
      "decline",
      "archive",
    ]);
  });
});

describe("recruiterReplyPackage", () => {
  it("replies on the message with the grade's fixed body, no cites and no follow-ups", () => {
    expect(reply()).toEqual({
      ok: true,
      value: {
        gmailMessageId: "18c3f0a2b4d6e8f1",
        threadId: "18c3f0a2b4d6e8ab",
        envelope: {
          to: "jo@acme.example",
          subject: "Re: Senior engineer role at Acme",
          inReplyTo: "<r2@acme.example>",
          references: ["<r1@acme.example>", "<r2@acme.example>"],
        },
        replyToOtherDomain: false,
        body: `Hi Jo, Thank you for reaching out. ${RECRUITER_REPLY_SENTENCES.interested}`,
        cites: [],
        followUps: [],
      },
    });
  });

  it("uses the more-info sentence for a C and the decline sentence for a D", () => {
    const body = (grade: "C" | "D") => {
      const r = reply({ grade });
      return r.ok ? r.value.body : null;
    };
    expect([body("C"), body("D")]).toEqual([
      `Hi Jo, Thank you for reaching out. ${RECRUITER_REPLY_SENTENCES.more_info}`,
      `Hi Jo, Thank you for reaching out. ${RECRUITER_REPLY_SENTENCES.decline}`,
    ]);
  });

  it("drafts nothing for an F and suggests archiving it, whatever its headers", () => {
    expect([
      reply({ grade: "F" }),
      reply({ grade: "F", inbound: { ...INBOUND, from: "a@acme.example, b@acme.example" } }),
    ]).toEqual([
      { ok: false, error: { kind: "ArchiveSuggested" } },
      { ok: false, error: { kind: "ArchiveSuggested" } },
    ]);
  });

  it("refuses a recipient nobody reads", () => {
    expect(reply({ inbound: { ...INBOUND, from: "Acme Talent <no-reply@acme.example>" } })).toEqual(
      { ok: false, error: { kind: "NoReplyAddress" } },
    );
  });

  it("greets nobody when the reply goes to a Reply-To, or the name isn't a plain first name", () => {
    expect([
      recruiterReplyBody("decline", "accept"),
      (() => {
        const r = reply({ inbound: { ...INBOUND, replyTo: "talent@acme.example" } });
        return r.ok ? r.value.body.slice(0, 3) : null;
      })(),
    ]).toEqual([`Hi, Thank you for reaching out. ${RECRUITER_REPLY_SENTENCES.decline}`, "Hi,"]);
  });

  it("holds no commitment word, digit, link or address in any whole body", () => {
    const sentences = (["interested", "more_info", "decline"] as const).map((k) =>
      recruiterReplyBody(k, null),
    );
    const words = sentences.flatMap((t) => t.split(/[^A-Za-z']+/));
    expect([
      words.filter((w) => w !== "" && isCommitmentWord(w)),
      sentences.filter((t) => /\d|@|:\/\/|www\./.test(t)),
    ]).toEqual([[], []]);
  });
});

describe("filing a reply by grade", () => {
  let db: Db;
  let close: () => Promise<void>;
  let candidateId: CandidateId;
  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    const [c] = await db.insert(schema.candidate).values({ displayName: "Test" }).returning();
    if (!c) throw new Error("no candidate");
    candidateId = CandidateId.parse(c.id);
  });
  afterEach(() => close());

  it("files with the Gate like any reply, and stores the fixed body Paul approves", async () => {
    const pkg = reply({ grade: "C" });
    if (!pkg.ok) throw new Error(pkg.error.kind);
    const filed = await fileReplyDraft(db, { candidateId, reply: pkg.value });
    if (!filed.ok) throw new Error(filed.error.kind);
    const stored = await readReplyDraft(db, candidateId, filed.value.requestId);
    expect([filed.value.stored, stored?.body, stored?.envelope.to]).toEqual([
      true,
      pkg.value.body,
      "jo@acme.example",
    ]);
  });
});
