import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { application, company, domainEvent, job } from "./schema.js";
import { createTestDb, type Seeded, seedApplication, sqlState } from "./test/pglite.js";

// SQLSTATE codes Postgres raises for each guard.
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const RESTRICT_VIOLATION = "23001";

let db: Db;
let close: () => Promise<void>;
let seeded: Seeded;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  seeded = await seedApplication(db, "discovered");
});

afterEach(async () => {
  await close();
});

const anEvent = (candidateId: string, key: string) => ({
  id: randomUUID(),
  candidateId,
  aggregate: `application:${seeded.applicationId}`,
  type: "application.scored",
  actor: "system",
  reason: "",
  inputsSummary: "",
  payload: { from: "discovered", to: "scored" },
  links: [],
  traceId: null,
  idempotencyKey: key,
  occurredAt: new Date("2026-11-24T12:00:00.000Z"),
});

describe("database guards", () => {
  it("has the pgvector extension installed by the first migration", async () => {
    // Db is driver-neutral, so execute()'s result type is unknown; both drivers return { rows }.
    const result = (await db.execute(
      sql`select extname from pg_extension where extname = 'vector'`,
    )) as { rows: unknown[] };
    expect(result.rows).toEqual([{ extname: "vector" }]);
  });

  it("rejects an application status the state machine does not know", async () => {
    const code = await sqlState(
      db
        .update(application)
        .set({ status: "hired" })
        .where(eq(application.id, seeded.applicationId)),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it("rejects a second application for the same job", async () => {
    const code = await sqlState(
      db.insert(application).values({
        candidateId: seeded.candidateId,
        jobId: seeded.jobId,
        status: "discovered",
      }),
    );
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it("rejects a job that points at another candidate's company", async () => {
    const other = await seedApplication(db, "discovered");
    const code = await sqlState(
      db.insert(job).values({
        candidateId: seeded.candidateId,
        companyId: other.companyId,
        title: "Data Engineer",
        url: "https://jobs.example.com/data-engineer",
      }),
    );
    expect(code).toBe(FOREIGN_KEY_VIOLATION);
  });

  it("rejects a company with no candidate", async () => {
    const code = await sqlState(
      db.insert(company).values({ candidateId: randomUUID(), name: "Orphan Corp" }),
    );
    expect(code).toBe(FOREIGN_KEY_VIOLATION);
  });

  it("rejects a second event with the same idempotency key", async () => {
    await db.insert(domainEvent).values(anEvent(seeded.candidateId, "same-key"));
    const code = await sqlState(
      db.insert(domainEvent).values(anEvent(seeded.candidateId, "same-key")),
    );
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it("rejects an UPDATE of a stored event", async () => {
    await db.insert(domainEvent).values(anEvent(seeded.candidateId, "k1"));
    const code = await sqlState(db.update(domainEvent).set({ reason: "rewritten history" }));
    expect(code).toBe(RESTRICT_VIOLATION);
  });

  it("rejects a DELETE of a stored event", async () => {
    await db.insert(domainEvent).values(anEvent(seeded.candidateId, "k1"));
    const code = await sqlState(db.delete(domainEvent));
    expect(code).toBe(RESTRICT_VIOLATION);
  });

  it("rejects a TRUNCATE of the event table", async () => {
    const code = await sqlState(db.execute(sql`truncate domain_event`));
    expect(code).toBe(RESTRICT_VIOLATION);
  });

  it("rejects a trace id that is not 32 lowercase hex characters", async () => {
    const code = await sqlState(
      db.insert(domainEvent).values({ ...anEvent(seeded.candidateId, "k2"), traceId: "ABC" }),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });
});
