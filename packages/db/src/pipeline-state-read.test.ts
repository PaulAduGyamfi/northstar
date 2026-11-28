import { randomUUID } from "node:crypto";
import { CandidateId } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { readPipelineState } from "./pipeline-state-read.js";
import { createTestDb, seedApplication } from "./test/pglite.js";

// The pipeline workflow's state reader (NS-280 slice 2) on PGlite. The filed-round case runs in
// packages/pipeline (prepare.test.ts), where a real package is filed.

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(() => close());

describe("readPipelineState (NS-280 slice 2)", () => {
  it("gives a queued application's status and job, with no package before any round", async () => {
    const seeded = await seedApplication(db, "queued");
    expect(
      await readPipelineState(db, CandidateId.parse(seeded.candidateId), seeded.applicationId),
    ).toEqual({ status: "queued", jobId: seeded.jobId, packageSha256: null });
  });

  it("finds nothing for another candidate's application, an unknown id or a malformed one", async () => {
    const seeded = await seedApplication(db, "queued");
    const other = await seedApplication(db, "queued");
    const mine = CandidateId.parse(seeded.candidateId);
    expect([
      await readPipelineState(db, mine, other.applicationId),
      await readPipelineState(db, mine, randomUUID()),
      await readPipelineState(db, mine, "not-a-uuid"),
    ]).toEqual([null, null, null]);
  });
});
