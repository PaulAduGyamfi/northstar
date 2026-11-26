import { CandidateId } from "@northstar/domain";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { llmSpend } from "./resilience-schema.js";
import { candidate } from "./schema.js";
import { readLlmSpend, recordLlmSpend } from "./spend-write.js";
import { createTestDb, sqlState } from "./test/pglite.js";

// LLM spend (NS-176 slice 2, ADR-0021). Synthetic amounts only.

const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";
const NOW = new Date("2026-11-26T12:00:00Z");

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;

async function newCandidate(): Promise<CandidateId> {
  const [c] = await db.insert(candidate).values({ displayName: "Test Candidate" }).returning();
  if (!c) throw new Error("no candidate");
  return CandidateId.parse(c.id);
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  candidateId = await newCandidate();
});

afterEach(async () => {
  await close();
});

// A row at a chosen time (the write path stamps now; the sums are about the calendar).
const at = (iso: string, usd: number, owner = candidateId) =>
  db.insert(llmSpend).values({
    candidateId: owner,
    route: "job-extract",
    costMicroUsd: Math.round(usd * 1_000_000),
    spentAt: new Date(iso),
  });

describe("readLlmSpend", () => {
  it("sums today and this month by the UTC calendar", async () => {
    await at("2026-11-26T00:00:00Z", 1.25);
    await at("2026-11-26T11:59:00Z", 0.5);
    await at("2026-11-25T23:59:59Z", 2);
    await at("2026-11-01T00:00:00Z", 3);
    await at("2026-10-31T23:59:59Z", 100);
    expect(await readLlmSpend(db, candidateId, NOW)).toEqual({ todayUsd: 1.75, monthUsd: 6.75 });
  });

  it("is zero with nothing spent, and counts each candidate's own spend only", async () => {
    await at("2026-11-26T01:00:00Z", 9, await newCandidate());
    expect(await readLlmSpend(db, candidateId, NOW)).toEqual({ todayUsd: 0, monthUsd: 0 });
  });
});

describe("recordLlmSpend", () => {
  it("stores a reply's cost exactly in micro-dollars", async () => {
    await recordLlmSpend(db, { candidateId, route: "job-extract", costUsd: 0.004321 });
    const [row] = await db.select({ micro: llmSpend.costMicroUsd }).from(llmSpend);
    expect(row?.micro).toBe(4321);
  });

  it("refuses a bad route name or a negative amount, in code and in the database", async () => {
    const bad = [
      recordLlmSpend(db, { candidateId, route: "Job Extract", costUsd: 1 }).catch(
        (e: Error) => e.message,
      ),
      recordLlmSpend(db, { candidateId, route: "job-extract", costUsd: -1 }).catch(
        (e: Error) => e.message,
      ),
    ];
    expect([
      ...(await Promise.all(bad)),
      await sqlState(db.insert(llmSpend).values({ candidateId, route: "x", costMicroUsd: -5 })),
    ]).toEqual(["recordLlmSpend: bad route name", "recordLlmSpend: bad amount", CHECK_VIOLATION]);
  });

  it("is append-only: UPDATE, DELETE and TRUNCATE are refused", async () => {
    await recordLlmSpend(db, { candidateId, route: "job-extract", costUsd: 1 });
    expect([
      await sqlState(db.update(llmSpend).set({ costMicroUsd: 0 })),
      await sqlState(db.delete(llmSpend)),
      await sqlState(db.execute(sql`truncate llm_spend`)),
    ]).toEqual([RESTRICT_VIOLATION, RESTRICT_VIOLATION, RESTRICT_VIOLATION]);
  });
});
