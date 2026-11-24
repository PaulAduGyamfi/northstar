import { ApplicationId, CandidateId } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { readEventsAfter } from "./read-events.js";
import { createTestDb, type Seeded, seedApplication } from "./test/pglite.js";
import { transitionApplication } from "./transition-application.js";

let db: Db;
let close: () => Promise<void>;
let seeded: Seeded;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  seeded = await seedApplication(db, "discovered");
  // Three moves in a row: discovered → scored → queued → package_ready.
  const moves = [
    ["discovered", "scored"],
    ["scored", "queued"],
    ["queued", "package_ready"],
  ] as const;
  for (const [from, to] of moves) {
    const result = await transitionApplication(db, {
      candidateId: CandidateId.parse(seeded.candidateId),
      applicationId: ApplicationId.parse(seeded.applicationId),
      from,
      to,
      actor: "system",
      reason: "",
      inputsSummary: "",
      links: [],
      idempotencyKey: `move-${to}`,
    });
    if (!result.ok) throw new Error(`seed move failed: ${result.error.kind}`);
  }
});

afterEach(async () => {
  await close();
});

const candidate = () => CandidateId.parse(seeded.candidateId);

describe("readEventsAfter", () => {
  it("returns every event in log order from the start", async () => {
    const events = await readEventsAfter(db, candidate(), 0n, 10);
    expect(events.map((e) => e.event.type)).toEqual([
      "application.scored",
      "application.queued",
      "application.package_ready",
    ]);
  });

  it("stores a null trace id when OpenTelemetry is not set up", async () => {
    // This file registers no tracer provider, so the API is a no-op.
    const events = await readEventsAfter(db, candidate(), 0n, 10);
    expect(events.map((e) => e.event.traceId)).toEqual([null, null, null]);
  });

  it("returns only the events after the cursor", async () => {
    const all = await readEventsAfter(db, candidate(), 0n, 10);
    const cursor = all[0]?.position ?? -1n;
    const rest = await readEventsAfter(db, candidate(), cursor, 10);
    expect(rest.map((e) => e.event.type)).toEqual([
      "application.queued",
      "application.package_ready",
    ]);
  });

  it("returns at most the limit", async () => {
    const events = await readEventsAfter(db, candidate(), 0n, 2);
    expect(events.map((e) => e.event.type)).toEqual(["application.scored", "application.queued"]);
  });

  it("returns nothing for another candidate", async () => {
    const other = await seedApplication(db, "discovered");
    const events = await readEventsAfter(db, CandidateId.parse(other.candidateId), 0n, 10);
    expect(events).toEqual([]);
  });
});
