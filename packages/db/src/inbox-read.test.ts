import { CandidateId } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { readInboxThreads } from "./inbox-read.js";
import { recordMailLink } from "./mail-link-write.js";
import { createApplication } from "./origin-write.js";
import { candidate, company, job } from "./schema.js";
import { createTestDb } from "./test/pglite.js";

// The unified inbox's read (NS-165) on PGlite. Invented companies, jobs and Gmail ids only.

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  candidateId = await newCandidate();
});

afterEach(async () => {
  await close();
});

async function newCandidate(): Promise<CandidateId> {
  const [c] = await db.insert(candidate).values({ displayName: "Test Candidate" }).returning();
  if (!c) throw new Error("no candidate");
  return CandidateId.parse(c.id);
}

// An application for a new job at `name`, created through the one write path with its origin.
async function newApplication(
  owner: CandidateId,
  name: string,
  title: string,
  startedBy: "northstar" | "outside",
): Promise<string> {
  const [co] = await db.insert(company).values({ candidateId: owner, name }).returning();
  if (!co) throw new Error("no company");
  const [j] = await db
    .insert(job)
    .values({
      candidateId: owner,
      companyId: co.id,
      title,
      url: `https://jobs.example.com/${name.toLowerCase()}`,
    })
    .returning();
  if (!j) throw new Error("no job");
  const created = await createApplication(db, {
    candidateId: owner,
    jobId: j.id,
    ...(startedBy === "outside"
      ? { status: "submitted", submittedVia: "by_hand" }
      : { status: "awaiting_approval" }),
    startedBy,
    idempotencyKey: `test:${name}`,
  });
  if (!created.ok) throw new Error(created.error.kind);
  return created.value.applicationId;
}

const at = (minute: number) => new Date(Date.UTC(2026, 10, 25, 12, minute));

async function link(
  owner: CandidateId,
  id: string,
  threadId: string,
  minute: number,
  decision: Parameters<typeof recordMailLink>[1]["decision"],
): Promise<void> {
  await recordMailLink(db, {
    candidateId: owner,
    message: { id, threadId, receivedAt: at(minute) },
    decision,
  });
}

describe("readInboxThreads", () => {
  it("groups linked threads by application, newest first, with counts, steps and origin", async () => {
    const globex = await newApplication(candidateId, "Globex", "Platform Engineer", "northstar");
    const initech = await newApplication(candidateId, "Initech", "Data Engineer", "outside");
    await link(candidateId, "a1", "aa01", 1, {
      kind: "linked",
      applicationId: globex,
      step: "tag",
      senderVerified: false,
    });
    await link(candidateId, "a2", "aa01", 5, {
      kind: "linked",
      applicationId: globex,
      step: "thread",
      senderVerified: true,
    });
    await link(candidateId, "b1", "bb01", 9, {
      kind: "linked",
      applicationId: initech,
      step: "sender",
      senderVerified: true,
    });
    await link(candidateId, "a3", "aa02", 3, {
      kind: "linked",
      applicationId: globex,
      step: "tag",
      senderVerified: false,
    });

    expect((await readInboxThreads(db, candidateId)).applications).toEqual([
      {
        applicationId: initech,
        jobTitle: "Data Engineer",
        company: "Initech",
        status: "submitted",
        origin: { startedBy: "outside", submittedVia: "by_hand" },
        threads: [
          {
            gmailThreadId: "bb01",
            messages: 1,
            lastReceivedAt: at(9),
            step: "sender",
            senderVerified: true,
            kind: null,
          },
        ],
      },
      {
        applicationId: globex,
        jobTitle: "Platform Engineer",
        company: "Globex",
        status: "awaiting_approval",
        origin: { startedBy: "northstar", submittedVia: null },
        threads: [
          {
            gmailThreadId: "aa01",
            messages: 2,
            lastReceivedAt: at(5),
            step: "thread",
            senderVerified: true,
            kind: null,
          },
          {
            gmailThreadId: "aa02",
            messages: 1,
            lastReceivedAt: at(3),
            step: "tag",
            senderVerified: false,
            kind: null,
          },
        ],
      },
    ]);
  });

  it("puts mail waiting to be linked in its own group, with the newest reason", async () => {
    await link(candidateId, "c1", "cc01", 1, { kind: "queued", reason: "no_match" });
    await link(candidateId, "c2", "cc01", 2, { kind: "queued", reason: "ambiguous" });
    await link(candidateId, "d1", "dd01", 4, { kind: "queued", reason: "unknown_tag" });
    expect(await readInboxThreads(db, candidateId)).toEqual({
      applications: [],
      queued: [
        { gmailThreadId: "dd01", messages: 1, lastReceivedAt: at(4), reason: "unknown_tag" },
        { gmailThreadId: "cc01", messages: 2, lastReceivedAt: at(2), reason: "ambiguous" },
      ],
    });
  });

  it("never shows another candidate's mail", async () => {
    const other = await newCandidate();
    const theirs = await newApplication(other, "Umbrella", "SRE", "northstar");
    await link(other, "e1", "ee01", 1, {
      kind: "linked",
      applicationId: theirs,
      step: "tag",
      senderVerified: true,
    });
    await link(other, "e2", "ee02", 2, { kind: "queued", reason: "no_match" });
    expect(await readInboxThreads(db, candidateId)).toEqual({ applications: [], queued: [] });
  });
});
