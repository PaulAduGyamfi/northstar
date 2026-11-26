import { randomUUID } from "node:crypto";
import { ApplicationId, type ApplicationStatus, CandidateId } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { readApplicationHistories } from "./pipeline-read.js";
import { domainEvent } from "./schema.js";
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
      h?.postedAt instanceof Date,
    ]).toEqual([
      ["package_ready", "awaiting_approval", "submitting", "submitted"],
      "2026-11-05T00:00:00.000Z",
      null,
      null,
      true,
    ]);
  });

  it("skips application events that aren't status moves", async () => {
    await db.insert(domainEvent).values({
      id: randomUUID(),
      candidateId,
      aggregate: `application:${applicationId}`,
      type: "application.created",
      actor: "agent:pipeline",
      reason: "",
      inputsSummary: "",
      payload: { startedBy: "agent" },
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
