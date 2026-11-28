import { type Db, fileReplyDraft, readReplyDraft, schema } from "@northstar/db";
import { createTestDb } from "@northstar/db/testing";
import { CandidateId } from "@northstar/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { displayName, NUDGE_SENTENCES, nudgeBody, nudgePackage } from "./nudge.js";
import { isCommitmentWord } from "./validate.js";

// A follow-up nudge as the Gate's reply package (NS-237 slice 3). Synthetic mail only.

const INBOUND = {
  from: "Jo Recruiter <jo@acme.example>",
  replyTo: null,
  subject: "Your application at Acme",
  messageId: "<m2@acme.example>",
  references: "<m1@acme.example>",
};

const nudge = (over: Partial<Parameters<typeof nudgePackage>[0]> = {}) =>
  nudgePackage({
    gmailMessageId: "18c3f0a2b4d6e8f0",
    threadId: "18c3f0a2b4d6e8aa",
    inbound: INBOUND,
    stage: "applied",
    ...over,
  });

describe("nudgePackage", () => {
  it("replies on the message with a fixed body, no cites and no follow-ups", () => {
    expect(nudge()).toEqual({
      ok: true,
      value: {
        gmailMessageId: "18c3f0a2b4d6e8f0",
        threadId: "18c3f0a2b4d6e8aa",
        envelope: {
          to: "jo@acme.example",
          subject: "Re: Your application at Acme",
          inReplyTo: "<m2@acme.example>",
          references: ["<m1@acme.example>", "<m2@acme.example>"],
        },
        replyToOtherDomain: false,
        body: "Hi Jo, I'm following up on my application and would be glad to hear about next steps. Thank you.",
        cites: [],
        followUps: [],
      },
    });
  });

  it("uses the interview sentence for an interview, and a nameless greeting for an unusable name", () => {
    expect([
      nudgeBody("interview", "Jo Recruiter"),
      nudgeBody("applied", "accept"),
      nudgeBody("applied", null),
    ]).toEqual([
      `Hi Jo, ${NUDGE_SENTENCES.interview} Thank you.`,
      `Hi, ${NUDGE_SENTENCES.applied} Thank you.`,
      `Hi, ${NUDGE_SENTENCES.applied} Thank you.`,
    ]);
  });

  it("holds no commitment word, digit, link or address in either stage's body", () => {
    const words = Object.values(NUDGE_SENTENCES).flatMap((t) => t.split(/[^A-Za-z']+/));
    expect([
      words.filter((w) => w !== "" && isCommitmentWord(w)),
      Object.values(NUDGE_SENTENCES).filter((t) => /\d|@|:\/\/|www\./.test(t)),
    ]).toEqual([[], []]);
  });

  it("greets the From header's own first name, and nobody when the reply goes to a Reply-To", () => {
    const greeting = (inbound: Parameters<typeof nudgePackage>[0]["inbound"]) => {
      const r = nudge({ inbound });
      return r.ok ? r.value.body.slice(0, r.value.body.indexOf(",") + 1) : null;
    };
    expect([
      greeting({ ...INBOUND, from: '"Dana Reyes" <dana@acme.example>' }),
      greeting({ ...INBOUND, from: "dana@acme.example" }),
      greeting({ ...INBOUND, replyTo: "talent@acme.example" }),
      displayName("Jo Recruiter <jo@acme.example>"),
      displayName("<jo@acme.example>"),
    ]).toEqual(["Hi Dana,", "Hi,", "Hi,", "Jo Recruiter", null]);
  });

  it("refuses a recipient nobody reads, whatever the spelling", () => {
    const to = (from: string) => nudge({ inbound: { ...INBOUND, from } });
    expect([
      to("Acme Careers <no-reply@acme.example>"),
      to("noreply@acme.example"),
      to("Do-Not-Reply@acme.example"),
      to("donotreply+jobs@acme.example"),
      to("noreply.talent@acme.example"),
      to("noreplyteam@acme.example").ok,
    ]).toEqual([...Array(5).fill({ ok: false, error: { kind: "NoReplyAddress" } }), true]);
  });

  it("flags a Reply-To on another domain, and refuses a sender that isn't one address", () => {
    expect([
      (() => {
        const r = nudge({ inbound: { ...INBOUND, replyTo: "jobs@elsewhere.example" } });
        return r.ok && [r.value.envelope.to, r.value.replyToOtherDomain];
      })(),
      nudge({ inbound: { ...INBOUND, from: "a@acme.example, b@acme.example" } }),
    ]).toEqual([
      ["jobs@elsewhere.example", true],
      { ok: false, error: { kind: "InvalidReply", fields: ["from"] } },
    ]);
  });
});

describe("filing a nudge", () => {
  let db: Db;
  let close: () => Promise<void>;
  let candidateId: CandidateId;
  // One database per file (NS-287): opening a PGlite copy per test passed Vitest's hook limit
  // under CI's parallel load. Each test makes its own candidate.
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  beforeEach(async () => {
    const [c] = await db.insert(schema.candidate).values({ displayName: "Test" }).returning();
    if (!c) throw new Error("no candidate");
    candidateId = CandidateId.parse(c.id);
  });
  afterAll(() => close());

  it("files with the Gate like any reply, and stores the fixed body Paul approves", async () => {
    const pkg = nudge();
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
