import { CandidateId } from "@northstar/domain";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { experienceAtom } from "./profile-schema.js";
import { writeProfileImport } from "./profile-write.js";
import { readEventsAfter } from "./read-events.js";
import { candidate } from "./schema.js";
import { createTestDb, sqlState } from "./test/pglite.js";
import { positioningThesis, positioningThesisAtom } from "./thesis-schema.js";
import { readCurrentThesis, readThesisHistory, saveApprovedThesis } from "./thesis-write.js";

const RESTRICT_VIOLATION = "23001";

let db: Db;
let close: () => Promise<void>;

async function newCandidate(): Promise<CandidateId> {
  const [c] = await db.insert(candidate).values({ displayName: "Test Candidate" }).returning();
  if (!c) throw new Error("no candidate");
  return CandidateId.parse(c.id);
}

// One synthetic resume import with two atoms; returns their ids.
async function importAtoms(owner: CandidateId): Promise<string[]> {
  await writeProfileImport(db, {
    candidateId: owner,
    fileName: "resume.txt",
    textSha256: "d".repeat(64),
    promptVersion: 1,
    model: "claude-opus-5-5",
    traceId: null,
    call: {},
    extract: {
      roles: [],
      education: [],
      atoms: [1, 2].map((n) => ({
        roleKey: null,
        what: `Synthetic achievement ${n}`,
        how: [],
        impact: null,
        scope: null,
        startMonth: null,
        endMonth: null,
        sourceQuote: `Did synthetic thing number ${n}.`,
        evidenceLink: null,
      })),
      skills: [],
      certifications: [],
      links: [],
    },
  });
  const rows = await db
    .select({ id: experienceAtom.id })
    .from(experienceAtom)
    .where(eq(experienceAtom.candidateId, owner))
    .orderBy(experienceAtom.position);
  return rows.map((r) => r.id);
}

let candidateId: CandidateId;
let atoms: string[];

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  candidateId = await newCandidate();
  atoms = await importAtoms(candidateId);
});

afterEach(async () => {
  await close();
});

const THESIS_A = "Backend engineer who builds synthetic things.";
const THESIS_B = "Backend engineer who now builds production agents.";

describe("saveApprovedThesis", () => {
  it("stores versions in order and the newest is current", async () => {
    expect(await saveApprovedThesis(db, { candidateId, text: THESIS_A, atomIds: atoms })).toEqual({
      ok: true,
      version: 1,
      saved: true,
    });
    expect(
      await saveApprovedThesis(db, { candidateId, text: THESIS_B, atomIds: [atoms[0] ?? ""] }),
    ).toEqual({ ok: true, version: 2, saved: true });
    const current = await readCurrentThesis(db, candidateId);
    expect([current?.version, current?.text, current?.atomIds]).toEqual([2, THESIS_B, [atoms[0]]]);
    expect((await readThesisHistory(db, candidateId)).map((t) => t.version)).toEqual([2, 1]);
  });

  it("stores the same text again as nothing new", async () => {
    await saveApprovedThesis(db, { candidateId, text: THESIS_A, atomIds: atoms });
    expect(await saveApprovedThesis(db, { candidateId, text: THESIS_A, atomIds: atoms })).toEqual({
      ok: true,
      version: 1,
      saved: false,
    });
    expect((await db.select().from(positioningThesis)).length).toBe(1);
  });

  it("refuses a thesis with no atom, or with another candidate's atom", async () => {
    expect(await saveApprovedThesis(db, { candidateId, text: THESIS_A, atomIds: [] })).toEqual({
      ok: false,
      error: { kind: "NoAtoms" },
    });
    const other = await newCandidate();
    const [foreign] = await importAtoms(other);
    expect(
      await saveApprovedThesis(db, { candidateId, text: THESIS_A, atomIds: [foreign ?? ""] }),
    ).toEqual({ ok: false, error: { kind: "AtomNotCurrent", atomIds: [foreign] } });
  });

  it("writes one feed event with the version and no thesis text", async () => {
    await saveApprovedThesis(db, { candidateId, text: THESIS_A, atomIds: atoms });
    const events = await readEventsAfter(db, candidateId, 0n, 50);
    const thesis = events.filter((e) => e.event.type === "thesis.approved");
    expect(thesis.map((e) => [e.event.payload.version, e.event.payload.atomCount])).toEqual([
      [1, 2],
    ]);
    expect(JSON.stringify(thesis.map((e) => e.event.payload))).not.toContain("synthetic things");
  });

  it("refuses to update or delete a thesis or its atom links", async () => {
    await saveApprovedThesis(db, { candidateId, text: THESIS_A, atomIds: atoms });
    expect(await sqlState(db.update(positioningThesis).set({ text: "Changed." }))).toBe(
      RESTRICT_VIOLATION,
    );
    expect(await sqlState(db.delete(positioningThesis))).toBe(RESTRICT_VIOLATION);
    expect(await sqlState(db.delete(positioningThesisAtom))).toBe(RESTRICT_VIOLATION);
  });
});
