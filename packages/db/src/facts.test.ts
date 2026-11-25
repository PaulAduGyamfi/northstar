import { CandidateId } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import {
  type OfficialPosition,
  readEmploymentFacts,
  recordFactsCheck,
  setEmploymentFacts,
} from "./facts-write.js";
import { employmentFact } from "./profile-schema.js";
import { candidate, domainEvent } from "./schema.js";
import { createTestDb, sqlState } from "./test/pglite.js";

const CHECK_VIOLATION = "23514";

// Synthetic employers and dates only (the repo is public).
const RECORD: OfficialPosition[] = [
  {
    employer: "Globex",
    title: "Software Engineer",
    startDate: "2019-06-03",
    endDate: "2021-02-28",
    current: false,
  },
  {
    employer: "Initech",
    title: "Senior Engineer",
    startDate: "2021-03",
    endDate: null,
    current: true,
  },
];

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const [c] = await db.insert(candidate).values({ displayName: "Test Candidate" }).returning();
  if (!c) throw new Error("no candidate");
  candidateId = CandidateId.parse(c.id);
});

afterEach(async () => {
  await close();
});

const events = () =>
  db
    .select()
    .from(domainEvent)
    .where(eq(domainEvent.candidateId, candidateId))
    .orderBy(domainEvent.position);

describe("employment facts", () => {
  it("stores the official record and reads it back in file order", async () => {
    expect(await setEmploymentFacts(db, { candidateId, positions: RECORD })).toEqual({
      status: "set",
      positions: 2,
    });
    expect(await readEmploymentFacts(db, candidateId)).toEqual(RECORD);
  });

  it("setting the same record twice stores one record and one event", async () => {
    await setEmploymentFacts(db, { candidateId, positions: RECORD });
    expect(await setEmploymentFacts(db, { candidateId, positions: RECORD })).toEqual({
      status: "unchanged",
      positions: 2,
    });
    expect(await db.select().from(employmentFact)).toHaveLength(2);
    expect(await events()).toHaveLength(1);
  });

  it("a new record supersedes the old rows instead of deleting them", async () => {
    await setEmploymentFacts(db, { candidateId, positions: RECORD });
    const fixed = [{ ...RECORD[0], endDate: "2021-03-05" } as OfficialPosition];
    await setEmploymentFacts(db, { candidateId, positions: fixed });
    expect(await readEmploymentFacts(db, candidateId)).toEqual(fixed);
    const all = await db.select().from(employmentFact);
    expect(all.filter((r) => r.supersededAt !== null)).toHaveLength(2);
  });

  it("the facts_set event holds counts only, no employer, title or date", async () => {
    await setEmploymentFacts(db, { candidateId, positions: RECORD });
    const [event] = await events();
    expect(event?.type).toBe("profile.facts_set");
    expect(event?.actor).toBe("user");
    expect(event?.payload).toEqual({ positions: 2 });
    // The fields a writer fills in; ids and timestamps are random and could contain a year.
    const text = JSON.stringify([event?.payload, event?.reason, event?.inputsSummary]);
    for (const value of ["Globex", "Initech", "Engineer", "2019", "2021"])
      expect(text).not.toContain(value);
  });

  it("the database refuses an ongoing position with an end date", async () => {
    const insert = db.insert(employmentFact).values({
      candidateId,
      employer: "Globex",
      title: "Engineer",
      startDate: "2019-06",
      endDate: "2021-02",
      isCurrent: true,
      position: 0,
    });
    expect(await sqlState(insert)).toBe(CHECK_VIOLATION);
  });

  it("the database refuses a date that isn't YYYY-MM or YYYY-MM-DD", async () => {
    const insert = db.insert(employmentFact).values({
      candidateId,
      employer: "Globex",
      title: "Engineer",
      startDate: "June 2019",
      endDate: null,
      isCurrent: true,
      position: 0,
    });
    expect(await sqlState(insert)).toBe(CHECK_VIOLATION);
  });

  it("recordFactsCheck writes counts by field and source, and no values", async () => {
    await recordFactsCheck(db, {
      candidateId,
      claims: 3,
      mismatches: [
        { source: "resume", field: "end" },
        { source: "resume", field: "current" },
      ],
    });
    const [event] = await events();
    expect(event?.type).toBe("profile.facts_checked");
    expect(event?.payload).toEqual({
      claims: 3,
      mismatches: 2,
      byField: { end: 1, current: 1 },
      bySource: { resume: 2 },
    });
  });

  it("the database refuses a second active record, so a race can't leave two", async () => {
    await setEmploymentFacts(db, { candidateId, positions: RECORD });
    const insert = db.insert(employmentFact).values({
      candidateId,
      employer: "Acme",
      title: "Engineer",
      startDate: "2018-01",
      endDate: "2019-01",
      isCurrent: false,
      position: 0,
    });
    expect(await sqlState(insert)).toBe("23505");
  });

  it("an empty record is refused rather than wiping the official record", async () => {
    await expect(setEmploymentFacts(db, { candidateId, positions: [] })).rejects.toThrow(
      "official record has no positions",
    );
    expect(await db.execute(sql`select count(*)::int as n from employment_fact`)).toMatchObject({
      rows: [{ n: 0 }],
    });
  });
});
