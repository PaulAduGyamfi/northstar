import { randomUUID } from "node:crypto";
import { CandidateId } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { readPipelineState, readPipelineWork } from "./pipeline-state-read.js";
import * as schema from "./schema.js";
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

  it("lists queued and package_ready applications to prepare, freshest first, with no open round", async () => {
    const seeded = await seedApplication(db, "queued");
    const candidateId = CandidateId.parse(seeded.candidateId);
    const [newer] = await db
      .insert(schema.application)
      .values({
        candidateId,
        jobId:
          (
            await db
              .insert(schema.job)
              .values({
                candidateId,
                companyId: seeded.companyId,
                title: "Platform Engineer",
                url: "https://jobs.example.com/platform",
              })
              .returning()
          )[0]?.id ?? "",
        status: "package_ready",
        createdAt: new Date(Date.now() + 60_000),
      })
      .returning();
    const work = await readPipelineWork(db, candidateId);
    expect(work).toEqual({
      toPrepare: [
        { applicationId: newer?.id, rounds: 0 },
        { applicationId: seeded.applicationId, rounds: 0 },
      ],
      openRounds: [],
    });
  });
});
