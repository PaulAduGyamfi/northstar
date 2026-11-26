import { ApplicationId, CandidateId } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { recordMailLink } from "./mail-link-write.js";
import { readNudgeCandidates } from "./nudge-read.js";
import { createApplication } from "./origin-write.js";
import { fileReplyDraft } from "./reply-write.js";
import { candidate, company, job } from "./schema.js";
import { createTestDb } from "./test/pglite.js";
import { transitionApplication } from "./transition-application.js";

// What the follow-up nudge check reads (NS-237 slice 3), on PGlite. Invented ids only.

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  candidateId = await newCandidate();
});
afterEach(() => close());

async function newCandidate(): Promise<CandidateId> {
  const [c] = await db.insert(candidate).values({ displayName: "Test Candidate" }).returning();
  if (!c) throw new Error("no candidate");
  return CandidateId.parse(c.id);
}

async function newApplication(
  owner: CandidateId,
  name: string,
  status: "submitted" | "awaiting_approval",
): Promise<string> {
  const [co] = await db.insert(company).values({ candidateId: owner, name }).returning();
  if (!co) throw new Error("no company");
  const [j] = await db
    .insert(job)
    .values({
      candidateId: owner,
      companyId: co.id,
      title: "Engineer",
      url: `https://jobs.example.com/${name}`,
    })
    .returning();
  if (!j) throw new Error("no job");
  const created = await createApplication(db, {
    candidateId: owner,
    jobId: j.id,
    ...(status === "submitted"
      ? { status: "submitted", submittedVia: "by_hand" }
      : { status: "awaiting_approval" }),
    startedBy: status === "submitted" ? "outside" : "northstar",
    idempotencyKey: `test:${name}`,
  });
  if (!created.ok) throw new Error(created.error.kind);
  return created.value.applicationId;
}

const at = (day: number) => new Date(Date.UTC(2026, 10, day, 12));

async function link(
  owner: CandidateId,
  applicationId: string,
  id: string,
  day: number,
  senderVerified = true,
) {
  await recordMailLink(db, {
    candidateId: owner,
    message: { id, threadId: "18c3f0a2b4d6e8aa", receivedAt: at(day) },
    decision: { kind: "linked", applicationId, step: "tag", senderVerified },
  });
}

async function fileDraft(owner: CandidateId, gmailMessageId: string) {
  const filed = await fileReplyDraft(db, {
    candidateId: owner,
    reply: {
      gmailMessageId,
      threadId: "18c3f0a2b4d6e8aa",
      envelope: {
        to: "jo@acme.example",
        subject: "Re: Your application",
        inReplyTo: "<m2@acme.example>",
        references: ["<m2@acme.example>"],
      },
      replyToOtherDomain: false,
      body: "Hi Jo, thank you.",
      cites: [],
      followUps: [],
    },
  });
  if (!filed.ok) throw new Error(filed.error.kind);
}

describe("readNudgeCandidates", () => {
  it("reads each application in a nudge stage with its last move, newest mail and filed flag", async () => {
    const acme = await newApplication(candidateId, "acme", "submitted");
    const moved = await transitionApplication(db, {
      candidateId,
      applicationId: ApplicationId.parse(acme),
      from: "submitted",
      to: "confirmed",
      actor: "system",
      reason: "Confirmation email",
      inputsSummary: "",
      links: [],
      idempotencyKey: "acme:confirmed",
      now: at(3),
    });
    if (!moved.ok) throw new Error(moved.error.kind);
    await link(candidateId, acme, "18c3f0a2b4d6e801", 2);
    await link(candidateId, acme, "18c3f0a2b4d6e802", 4);
    const quiet = await newApplication(candidateId, "globex", "submitted");
    await newApplication(candidateId, "initech", "awaiting_approval");
    const rows = await readNudgeCandidates(db, candidateId);
    const byId = new Map(rows.map((r) => [r.applicationId, r]));
    expect([
      rows.length,
      byId.get(acme),
      [byId.get(quiet)?.status, byId.get(quiet)?.lastMail, byId.get(quiet)?.replyFiled],
    ]).toEqual([
      2,
      {
        applicationId: acme,
        status: "confirmed",
        lastMoveAt: at(3),
        lastMail: {
          gmailMessageId: "18c3f0a2b4d6e802",
          threadId: "18c3f0a2b4d6e8aa",
          receivedAt: at(4),
          kind: null,
        },
        replyFiled: false,
      },
      ["submitted", null, false],
    ]);
  });

  it("marks the newest message filed once a reply draft is filed for it", async () => {
    const acme = await newApplication(candidateId, "acme", "submitted");
    await link(candidateId, acme, "18c3f0a2b4d6e802", 4);
    await fileDraft(candidateId, "18c3f0a2b4d6e802");
    expect((await readNudgeCandidates(db, candidateId)).map((r) => r.replyFiled)).toEqual([true]);
  });

  it("reads no other candidate's applications or mail", async () => {
    const other = await newCandidate();
    const theirs = await newApplication(other, "umbrella", "submitted");
    await link(other, theirs, "18c3f0a2b4d6e8c1", 4);
    expect(await readNudgeCandidates(db, candidateId)).toEqual([]);
  });

  it("checks the filed flag on the newest message only, and only the candidate's own drafts", async () => {
    const acme = await newApplication(candidateId, "acme", "submitted");
    await link(candidateId, acme, "18c3f0a2b4d6e801", 2);
    await link(candidateId, acme, "18c3f0a2b4d6e802", 4);
    // A queued link (no application) changes nothing.
    await recordMailLink(db, {
      candidateId,
      message: { id: "18c3f0a2b4d6e8f9", threadId: "18c3f0a2b4d6e8aa", receivedAt: at(8) },
      decision: { kind: "queued", reason: "no_match" },
    });
    // A draft on the older message, and another candidate's draft on the newest.
    await fileDraft(candidateId, "18c3f0a2b4d6e801");
    await fileDraft(await newCandidate(), "18c3f0a2b4d6e802");
    const [row] = await readNudgeCandidates(db, candidateId);
    expect([row?.lastMail?.gmailMessageId, row?.replyFiled]).toEqual(["18c3f0a2b4d6e802", false]);
  });

  it("counts only mail from a verified sender: unverified mail neither replies nor resets", async () => {
    const acme = await newApplication(candidateId, "acme", "submitted");
    await link(candidateId, acme, "18c3f0a2b4d6e801", 2);
    await link(candidateId, acme, "18c3f0a2b4d6e809", 9, false);
    const [row] = await readNudgeCandidates(db, candidateId);
    expect(row?.lastMail).toEqual({
      gmailMessageId: "18c3f0a2b4d6e801",
      threadId: "18c3f0a2b4d6e8aa",
      receivedAt: at(2),
      kind: null,
    });
  });
});
