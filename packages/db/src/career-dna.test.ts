import { CandidateId } from "@northstar/domain";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { careerDnaReport } from "./career-dna-schema.js";
import {
  type CareerDnaSnapshot,
  readCareerDnaHistory,
  saveCareerDnaReport,
} from "./career-dna-write.js";
import type { Db } from "./db.js";
import { candidate, domainEvent } from "./schema.js";
import { createTestDb, sqlState } from "./test/pglite.js";

// Career DNA report history (NS-130 slice 4, DNA-008) on PGlite. Invented ids only.

const RESTRICT_VIOLATION = "23001";

const exporter = new InMemorySpanExporter();
beforeAll(() => {
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});
afterAll(() => trace.disable());

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
  exporter.reset();
});
afterEach(() => close());

const A1 = "00000000-0000-4000-8000-0000000000a1";
const A2 = "00000000-0000-4000-8000-0000000000a2";
const S1 = "00000000-0000-4000-8000-0000000000b1";

const SNAPSHOT: CareerDnaSnapshot = {
  rubricVersion: 1,
  family: "software_engineering",
  dimensions: [
    {
      key: "engineering",
      band: "low",
      points: 4,
      evidenceCount: 3,
      atomIds: [A1, A2],
      storyIds: [S1],
    },
    {
      key: "leadership",
      band: "not_enough",
      points: null,
      evidenceCount: 0,
      atomIds: [],
      storyIds: [],
    },
  ],
  archetype: { label: "The Builder", dimensions: ["engineering"] },
};

const save = (snapshot: unknown = SNAPSHOT, who = candidateId) =>
  saveCareerDnaReport(db, { candidateId: who, snapshot });

describe("saveCareerDnaReport", () => {
  it("stores a report once, and a changed report as the next version", async () => {
    const first = await save();
    const again = await save();
    const changed = await save({
      ...SNAPSHOT,
      dimensions: [{ ...SNAPSHOT.dimensions[0], atomIds: [A1] }, SNAPSHOT.dimensions[1]],
    });
    if (!first.ok || !again.ok || !changed.ok) throw new Error("not saved");
    expect([
      [first.value.stored, first.value.version],
      [again.value.stored, again.value.version, again.value.reportId === first.value.reportId],
      [changed.value.stored, changed.value.version],
    ]).toEqual([
      [true, 1],
      [false, 1, true],
      [true, 2],
    ]);
    const history = await readCareerDnaHistory(db, candidateId);
    expect(history.map((h) => [h.version, h.dimensions[0]?.atomIds])).toEqual([
      [2, [A1]],
      [1, [A1, A2]],
    ]);
    expect(history[1]?.archetype).toEqual(SNAPSHOT.archetype);
  });

  it("refuses a snapshot holding text, an unknown band or a bad id, and stores nothing", async () => {
    const dim = SNAPSHOT.dimensions[0];
    const results = await Promise.all([
      save({ ...SNAPSHOT, dimensions: [{ ...dim, quote: "Led the billing migration" }] }),
      save({ ...SNAPSHOT, dimensions: [{ ...dim, band: "great" }] }),
      save({ ...SNAPSHOT, dimensions: [{ ...dim, atomIds: ["Led the billing migration"] }] }),
      save({
        ...SNAPSHOT,
        archetype: { label: "Led <b>billing</b>", dimensions: ["engineering"] },
      }),
    ]);
    expect(results.map((r) => (r.ok ? "stored" : r.error.fields))).toEqual([
      ["dimensions"],
      ["dimensions"],
      ["dimensions"],
      ["archetype"],
    ]);
    expect(await db.select().from(careerDnaReport)).toEqual([]);
  });

  it("writes one event with the version and a count, never a cited id", async () => {
    await save();
    await save();
    const events = await db
      .select()
      .from(domainEvent)
      .where(eq(domainEvent.type, "career_dna.saved"));
    expect(events.map((e) => [e.reason, (e.payload as { version: number }).version])).toEqual([
      ["Updated your Career DNA report", 1],
    ]);
    expect(JSON.stringify(events.map((e) => e.payload))).not.toMatch(
      /0{8}-0{4}-4000-8000-0{10}[ab]/,
    );
  });

  it("keeps each candidate's history its own", async () => {
    await save();
    const other = await newCandidate();
    const theirs = await save(SNAPSHOT, other);
    if (!theirs.ok) throw new Error("not saved");
    expect([theirs.value.version, (await readCareerDnaHistory(db, other)).length]).toEqual([1, 1]);
  });
});

describe("the career_dna_report table", () => {
  it("refuses UPDATE, DELETE and TRUNCATE", async () => {
    await save();
    expect([
      await sqlState(db.update(careerDnaReport).set({ version: 9 })),
      await sqlState(db.delete(careerDnaReport)),
      await sqlState(db.execute(sql`truncate career_dna_report`)),
    ]).toEqual([RESTRICT_VIOLATION, RESTRICT_VIOLATION, RESTRICT_VIOLATION]);
  });
});
