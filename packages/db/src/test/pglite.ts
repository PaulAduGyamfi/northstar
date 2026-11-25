import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import type { ApplicationStatus } from "@northstar/domain";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { inject } from "vitest";
import type { Db } from "../db.js";
import * as schema from "../schema.js";

// Test helpers, also built into dist and exported as `@northstar/db/testing` so other packages'
// tests (the Apply Gateway, NS-120) can run against the real write paths. Never imported by
// application code. A package using it points Vitest's globalSetup at dist/test/global-setup.js.

// The migrated, empty data directory that global-setup.ts built once for this run, read once per
// test file. No test hook applies migrations: that work made the first beforeEach of a file pass
// Vitest's 10 s hook limit when CI ran every package's tests at once.
let snapshot: Promise<Blob> | undefined;

// A fresh in-memory Postgres (PGlite, ADR-0012) with every committed migration applied, and no
// rows: each test gets its own copy of the snapshot. It never touches a server, so the "_test
// database names only" rule can't be broken from here.
export async function createTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  snapshot ??= readFile(inject("pgliteSnapshot")).then((bytes) => new Blob([bytes]));
  const client = new PGlite({ extensions: { vector }, loadDataDir: await snapshot });
  const db = drizzle({ client, schema });
  return { db, close: () => client.close() };
}

export type Seeded = {
  candidateId: string;
  companyId: string;
  jobId: string;
  applicationId: string;
};

// One synthetic candidate, company, job and application in the given status.
export async function seedApplication(db: Db, status: ApplicationStatus): Promise<Seeded> {
  const [c] = await db
    .insert(schema.candidate)
    .values({ displayName: "Test Candidate" })
    .returning();
  if (!c) throw new Error("seed: no candidate row");
  const [co] = await db
    .insert(schema.company)
    .values({ candidateId: c.id, name: "Example Corp" })
    .returning();
  if (!co) throw new Error("seed: no company row");
  const [j] = await db
    .insert(schema.job)
    .values({
      candidateId: c.id,
      companyId: co.id,
      title: "Backend Engineer",
      url: "https://jobs.example.com/backend-engineer",
    })
    .returning();
  if (!j) throw new Error("seed: no job row");
  const [a] = await db
    .insert(schema.application)
    .values({ candidateId: c.id, jobId: j.id, status })
    .returning();
  if (!a) throw new Error("seed: no application row");
  return { candidateId: c.id, companyId: co.id, jobId: j.id, applicationId: a.id };
}

// The Postgres error code (SQLSTATE) a failed query raised. Drizzle wraps driver errors, so look
// at the cause too. Returns null if the query succeeded.
export async function sqlState(query: PromiseLike<unknown>): Promise<string | null> {
  try {
    await query;
    return null;
  } catch (error) {
    const own = (error as { code?: unknown }).code;
    const cause = (error as { cause?: { code?: unknown } }).cause?.code;
    const code = typeof own === "string" ? own : cause;
    return typeof code === "string" ? code : "no-sqlstate";
  }
}

// Pins the Gate's database clock (northstar_gate_now(), migration 0016) for this connection.
// Test databases only: global-setup.ts makes the function read this setting.
export async function setGateClock(db: Db, at: Date): Promise<void> {
  await db.execute(sql`select set_config('northstar.gate_test_now', ${at.toISOString()}, false)`);
}
