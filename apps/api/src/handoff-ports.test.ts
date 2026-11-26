import { type Db, readOrigin } from "@northstar/db";
import { createTestDb, type Seeded, seedApplication } from "@northstar/db/testing";
import { ApplicationId, CandidateId } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markHandoffSubmitted } from "./handoff-ports.js";

// "I submitted it" on the real write path (NS-188, INB-007). Synthetic data only.

let db: Db;
let close: () => Promise<void>;
let seeded: Seeded;

// Seeded in the hook, as the API's other database tests do: a fresh PGlite's first queries are
// slow on a busy CI runner, and the hook has room for that where the test body's 5 s doesn't.
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  seeded = await seedApplication(db, "needs_human");
});

afterEach(async () => {
  await close();
});

describe("markHandoffSubmitted", () => {
  it("moves the application to submitted and records that it went out by handoff", async () => {
    const candidateId = CandidateId.parse(seeded.candidateId);
    const moved = await markHandoffSubmitted(db, candidateId, seeded.applicationId, "handoff:1");
    const origin = await readOrigin(db, candidateId, ApplicationId.parse(seeded.applicationId));
    expect([moved.ok, origin.submittedVia]).toEqual([true, "handoff"]);
  });
});
