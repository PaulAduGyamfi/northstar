import { CandidateId } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { readDeadLetterKeys, recordDeadLetter, resolveDeadLetter } from "./dead-letter-write.js";
import { recordMailClassification } from "./mail-classification-write.js";
import { decideQueuedThread } from "./mail-link-decision-write.js";
import { recordMailLink } from "./mail-link-write.js";
import {
  countUngradedRecruiterMail,
  readRecordedMessageIds,
  readUnclassifiedMail,
  readUngradedRecruiterMail,
} from "./mail-loop-read.js";
import { recordRecruiterGrade } from "./recruiter-grade-write.js";
import { candidate } from "./schema.js";
import { createTestDb, seedApplication } from "./test/pglite.js";

// What `funnel inbox` (NS-238 item 1) reads after linking, on PGlite. Invented Gmail ids only.

const M1 = "18c3f0a2b4d6e801";
const M2 = "18c3f0a2b4d6e802";
const M3 = "18c3f0a2b4d6e803";
const M4 = "18c3f0a2b4d6e804";

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let applicationId: string;

// A message recorded on the given November day: linked to the application, or queued.
async function recorded(id: string, day: number, linked: boolean, owner = candidateId) {
  await recordMailLink(db, {
    candidateId: owner,
    message: { id, threadId: id, receivedAt: new Date(Date.UTC(2026, 10, day, 12)) },
    decision: linked
      ? { kind: "linked", applicationId, step: "tag", senderVerified: false }
      : { kind: "queued", reason: "no_match" },
  });
}

const classify = (id: string, kind: string) =>
  recordMailClassification(db, {
    candidateId,
    gmailMessageId: id,
    result: { outcome: "classified", kind, stageSignal: "none", decidedBy: "rules" },
  });

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const seeded = await seedApplication(db, "submitted");
  candidateId = CandidateId.parse(seeded.candidateId);
  applicationId = seeded.applicationId;
});
afterEach(() => close());

describe("readUnclassifiedMail", () => {
  it("gives unclassified messages, linked and queued, newest first, up to the limit", async () => {
    await recorded(M1, 1, true);
    await recorded(M2, 2, false);
    await recorded(M3, 3, true);
    await recorded(M4, 4, false);
    await classify(M3, "confirmation");
    expect((await readUnclassifiedMail(db, candidateId, 2)).map((m) => m.gmailMessageId)).toEqual([
      M4,
      M2,
    ]);
  });

  it("leaves out a message Paul dismissed and another candidate's mail", async () => {
    const [other] = await db.insert(candidate).values({ displayName: "Other" }).returning();
    if (!other) throw new Error("no candidate");
    await recorded(M1, 1, false);
    await recorded(M2, 2, false);
    await recorded(M3, 3, false, CandidateId.parse(other.id));
    await decideQueuedThread(db, { candidateId, gmailThreadId: M2, decision: { kind: "dismiss" } });
    expect((await readUnclassifiedMail(db, candidateId, 25)).map((m) => m.gmailMessageId)).toEqual([
      M1,
    ]);
  });
});

describe("readUngradedRecruiterMail", () => {
  it("gives recruiter mail with no grade, newest first, leaving out graded, dismissed and other kinds", async () => {
    for (const [id, day] of [
      [M1, 1],
      [M2, 2],
      [M3, 3],
      [M4, 4],
    ] as const) {
      await recorded(id, day, false);
    }
    await classify(M1, "recruiter_inbound");
    await classify(M2, "recruiter_inbound");
    await classify(M3, "recruiter_inbound");
    await classify(M4, "confirmation");
    await recordRecruiterGrade(db, {
      candidateId,
      gmailMessageId: M2,
      grade: { grade: "B", points: 4, reasons: ["title:exact"], confidence: "normal" },
    });
    await decideQueuedThread(db, { candidateId, gmailThreadId: M3, decision: { kind: "dismiss" } });
    expect(
      (await readUngradedRecruiterMail(db, candidateId, 10)).map((m) => m.gmailMessageId),
    ).toEqual([M1]);
  });

  it("leaves out another candidate's recruiter mail", async () => {
    const [other] = await db.insert(candidate).values({ displayName: "Other" }).returning();
    if (!other) throw new Error("no candidate");
    const otherId = CandidateId.parse(other.id);
    await recorded(M1, 1, false, otherId);
    await recordMailClassification(db, {
      candidateId: otherId,
      gmailMessageId: M1,
      result: {
        outcome: "classified",
        kind: "recruiter_inbound",
        stageSignal: "none",
        decidedBy: "rules",
      },
    });
    expect(await readUngradedRecruiterMail(db, candidateId, 10)).toEqual([]);
  });

  it("gives newest first up to the limit", async () => {
    await recorded(M1, 1, false);
    await recorded(M2, 2, false);
    await classify(M1, "recruiter_inbound");
    await classify(M2, "recruiter_inbound");
    expect(
      (await readUngradedRecruiterMail(db, candidateId, 1)).map((m) => m.gmailMessageId),
    ).toEqual([M2]);
  });
});

describe("readRecordedMessageIds", () => {
  it("gives the given messages the loop recorded, the candidate's own only", async () => {
    const [other] = await db.insert(candidate).values({ displayName: "Other" }).returning();
    if (!other) throw new Error("no candidate");
    await recorded(M1, 1, true);
    await recorded(M2, 2, false, CandidateId.parse(other.id));
    expect(await readRecordedMessageIds(db, candidateId, [M1, M2, M3])).toEqual(new Set([M1]));
  });
});

describe("countUngradedRecruiterMail", () => {
  it("counts recruiter mail with no grade, leaving out graded, dismissed and other kinds", async () => {
    for (const [id, day] of [
      [M1, 1],
      [M2, 2],
      [M3, 3],
      [M4, 4],
    ] as const) {
      await recorded(id, day, false);
    }
    await classify(M1, "recruiter_inbound");
    await classify(M2, "recruiter_inbound");
    await classify(M3, "recruiter_inbound");
    await classify(M4, "confirmation");
    await recordRecruiterGrade(db, {
      candidateId,
      gmailMessageId: M2,
      grade: { grade: "B", points: 4, reasons: ["title:exact"], confidence: "normal" },
    });
    await decideQueuedThread(db, { candidateId, gmailThreadId: M3, decision: { kind: "dismiss" } });
    expect(await countUngradedRecruiterMail(db, candidateId)).toBe(1);
  });
});

describe("readDeadLetterKeys", () => {
  it("gives one kind's letters with Paul's resolution, null while open", async () => {
    const letter = (kind: string, key: string) =>
      recordDeadLetter(db, {
        candidateId,
        kind,
        subject: `candidate:${candidateId}`,
        reasonCode: "read_failed",
        attempts: 3,
        idempotencyKey: key,
      });
    const first = await letter("mail.poll", `mail.poll:${M1}:1`);
    await letter("mail.poll", `mail.poll:${M2}:1`);
    await letter("mail.classify", `mail.classify:${M3}:1`);
    if (!first.ok) throw new Error(first.error.field);
    await resolveDeadLetter(db, {
      candidateId,
      deadLetterId: first.value.deadLetterId,
      action: "retry",
      actor: "user",
    });
    expect(await readDeadLetterKeys(db, candidateId, "mail.poll")).toEqual([
      { idempotencyKey: `mail.poll:${M1}:1`, action: "retry" },
      { idempotencyKey: `mail.poll:${M2}:1`, action: null },
    ]);
  });
});
