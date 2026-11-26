import { type Db, readOrigin } from "@northstar/db";
import { createTestDb, seedApplication } from "@northstar/db/testing";
import { ApplicationId, CandidateId } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markHandoffSubmitted } from "./handoff-ports.js";

// "I submitted it" on the real write path (NS-188, INB-007). Synthetic data only.

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  await close();
});

describe("markHandoffSubmitted", () => {
  it("moves the application to submitted and records that it went out by handoff", async () => {
    const seeded = await seedApplication(db, "needs_human");
    const candidateId = CandidateId.parse(seeded.candidateId);
    const moved = await markHandoffSubmitted(db, candidateId, seeded.applicationId, "handoff:1");
    const origin = await readOrigin(db, candidateId, ApplicationId.parse(seeded.applicationId));
    expect([moved.ok, origin.submittedVia]).toEqual([true, "handoff"]);
  });
});
