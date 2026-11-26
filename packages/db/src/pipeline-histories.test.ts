import { randomUUID } from "node:crypto";
import { ApplicationId, type ApplicationStatus, CandidateId } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { createApplication } from "./origin-write.js";
import { readApplicationHistories } from "./pipeline-read.js";
import { domainEvent, job } from "./schema.js";
import { createTestDb, seedApplication } from "./test/pglite.js";
import { transitionApplication } from "./transition-application.js";

// The pipeline metrics' read (NS-208) on PGlite. Synthetic applications only.

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let applicationId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const seeded = await seedApplication(db, "queued");
  candidateId = CandidateId.parse(seeded.candidateId);
  applicationId = seeded.applicationId;
});

afterEach(async () => {
  await close();
});

const T0 = Date.parse("2026-11-01T00:00:00Z");

// Moves the application along a legal path, one day apart.
async function walk(id: string, path: ApplicationStatus[]): Promise<void> {
  for (const [i, to] of path.slice(1).entries()) {
    const from = path[i] as ApplicationStatus;
    const result = await transitionApplication(db, {
      candidateId,
      applicationId: ApplicationId.parse(id),
      from,
      to,
      actor: "agent:pipeline",
      reason: "",
      inputsSummary: "",
      links: [],
      idempotencyKey: randomUUID(),
      now: new Date(T0 + (i + 1) * 86_400_000),
      ...(to === "submitted" ? { submittedVia: "approved" as const } : {}),
    });
    if (!result.ok) throw new Error(`${from} → ${to}: ${result.error.kind}`);
  }
}

describe("readApplicationHistories", () => {
  it("gives each application's status moves in order, with its source and posting time", async () => {
    await walk(applicationId, [
      "queued",
      "package_ready",
      "awaiting_approval",
      "submitting",
      "submitted",
    ]);
    const [h] = await readApplicationHistories(db, candidateId);
    expect([
      h?.moves.map((m) => m.to),
      h?.moves.at(-1)?.at.toISOString(),
      h?.source,
      h?.fitBand,
      h?.postedAt,
    ]).toEqual([
      ["package_ready", "awaiting_approval", "submitting", "submitted"],
      "2026-11-05T00:00:00.000Z",
      null,
      null,
      null,
    ]);
  });

  it("counts an application Paul sent by hand as applied from its creation, with its posting time", async () => {
    const [j] = await db
      .insert(job)
      .values({
        candidateId,
        title: "Engineer",
        url: "https://jobs.example.com/by-hand",
        // A draft: a ready job needs a company, and this test needs none.
        status: "draft",
        missingFields: ["company"],
        postedAt: new Date("2026-10-30T00:00:00Z"),
      })
      .returning();
    const created = await createApplication(db, {
      candidateId,
      jobId: j?.id ?? "",
      status: "submitted",
      submittedVia: "by_hand",
      startedBy: "outside",
      idempotencyKey: randomUUID(),
    });
    if (!created.ok) throw new Error(created.error.kind);
    const histories = await readApplicationHistories(db, candidateId);
    const byHand = histories.find((h) => h.moves.some((m) => m.to === "submitted"));
    expect([byHand?.moves.map((m) => m.to), byHand?.postedAt?.toISOString()]).toEqual([
      ["submitted"],
      "2026-10-30T00:00:00.000Z",
    ]);
  });

  it("skips an application event without a status", async () => {
    await db.insert(domainEvent).values({
      id: randomUUID(),
      candidateId,
      aggregate: `application:${applicationId}`,
      type: "application.noted",
      actor: "agent:pipeline",
      reason: "",
      inputsSummary: "",
      payload: { note: "count" },
      links: [],
      traceId: null,
      idempotencyKey: randomUUID(),
      occurredAt: new Date(T0),
    });
    const [h] = await readApplicationHistories(db, candidateId);
    expect(h?.moves).toEqual([]);
  });

  it("never reads another candidate's applications or moves", async () => {
    const other = await seedApplication(db, "queued");
    const otherId = CandidateId.parse(other.candidateId);
    expect([
      (await readApplicationHistories(db, candidateId)).length,
      (await readApplicationHistories(db, otherId)).length,
    ]).toEqual([1, 1]);
  });
});
