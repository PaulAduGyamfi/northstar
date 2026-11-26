import { type Db, listOpenDeadLetters } from "@northstar/db";
import { createTestDb, seedApplication } from "@northstar/db/testing";
import { CandidateId } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSweepActivities } from "./sweep.js";

let db: Db;
let close: () => Promise<void>;
let candidateId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  candidateId = (await seedApplication(db, "awaiting_approval")).candidateId;
});
afterEach(() => close());

describe("the sweepStaleClaims activity", () => {
  it("runs the gateway's sweep for the candidate and returns how many claims it closed", async () => {
    const seen: string[] = [];
    const activities = createSweepActivities(async (c) => {
      seen.push(c);
      return ["s1", "s2"];
    }, db);
    await expect(activities.sweepStaleClaims({ candidateId })).resolves.toEqual({ closed: 2 });
    expect(seen).toEqual([candidateId]);
  });

  it("lets a failed pass through for the retry policy", async () => {
    const boom = new Error("database down");
    const activities = createSweepActivities(async () => {
      throw boom;
    }, db);
    await expect(activities.sweepStaleClaims({ candidateId })).rejects.toBe(boom);
  });

  it("refuses a candidate id that isn't a uuid, without retry, before sweeping", async () => {
    let called = false;
    const activities = createSweepActivities(async () => {
      called = true;
      return [];
    }, db);
    const failure = await activities
      .sweepStaleClaims({ candidateId: "nope" })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ type: "InvalidInput", nonRetryable: true });
    expect(called).toBe(false);
  });
});

describe("the recordSweepFailure activity", () => {
  it("records a failed pass as one dead letter, even when called twice", async () => {
    const activities = createSweepActivities(async () => [], db);
    const key = "stale_sweep:00000000-0000-4000-8000-0000000000c1:7";
    await activities.recordSweepFailure({ candidateId, key });
    await activities.recordSweepFailure({ candidateId, key });
    const letters = await listOpenDeadLetters(db, CandidateId.parse(candidateId));
    expect(letters).toEqual([
      expect.objectContaining({
        kind: "apply.stale_sweep",
        subject: `candidate:${candidateId}`,
        reasonCode: "sweep_failed",
        attempts: 3,
      }),
    ]);
  });
});
