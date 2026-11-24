import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import type { ApplicationStatus } from "@northstar/domain";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Db } from "../db.js";
import * as schema from "../schema.js";

const migrationsFolder = fileURLToPath(new URL("../../migrations", import.meta.url));

// A fresh in-memory Postgres (PGlite, ADR-0012) with every committed migration applied. It never
// touches a server, so the "_test database names only" rule can't be broken from here.
export async function createTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite({ extensions: { vector } });
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder });
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
