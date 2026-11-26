import { CandidateId } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { writeProfileImport } from "./profile-write.js";
import { domainEvent, job } from "./schema.js";
import { tailoredResume } from "./tailor-schema.js";
import {
  readTailoredResumes,
  readTailorInput,
  type SaveTailoredInput,
  saveTailoredResume,
  type TailorSummary,
} from "./tailor-write.js";
import { createTestDb, seedApplication, sqlState } from "./test/pglite.js";

// Tailored resumes (NS-146). Synthetic profile and job only.

const RESTRICT_VIOLATION = "23001";

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let jobId: string;

async function importProfile(owner: CandidateId): Promise<void> {
  await writeProfileImport(db, {
    candidateId: owner,
    fileName: "resume.txt",
    textSha256: "e".repeat(64),
    promptVersion: 1,
    model: "claude-opus-5-5",
    traceId: null,
    call: {},
    extract: {
      roles: [
        {
          key: "r1",
          employer: "Example Corp",
          title: "Engineer",
          startMonth: "2020-01",
          endMonth: null,
          current: true,
        },
      ],
      education: [],
      atoms: [1, 2].map((n) => ({
        roleKey: "r1",
        what: `Synthetic achievement ${n}`,
        how: ["Go"],
        impact: null,
        scope: null,
        startMonth: null,
        endMonth: null,
        sourceQuote: `Did synthetic thing number ${n} in Go.`,
        evidenceLink: null,
      })),
      skills: ["Go"],
      certifications: [],
      links: [],
    },
  });
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const seeded = await seedApplication(db, "discovered");
  candidateId = CandidateId.parse(seeded.candidateId);
  jobId = seeded.jobId;
});

afterEach(async () => {
  await close();
});

const summary: TailorSummary = {
  lines: 2,
  atoms: 2,
  addedSkills: 0,
  droppedSkills: 0,
  notClaimed: 1,
  keywordsCovered: 1,
  keywordsTotal: 2,
  titleMatch: "partial",
  atsPass: true,
  valid: true,
  failures: 0,
};

const save = (over: Partial<SaveTailoredInput> = {}, sourceId = "") =>
  saveTailoredResume(db, {
    candidateId,
    jobId,
    profileSourceId: sourceId,
    resume: { summary: [], sections: [], skills: [], notClaimed: ["Secret Requirement"] },
    validation: { ok: true },
    score: { title: "partial" },
    droppedSkills: [],
    summary,
    ...over,
  });

async function sourceId(): Promise<string> {
  const r = await readTailorInput(db, candidateId, jobId);
  if (!r.ok) throw new Error(r.error.kind);
  return r.value.profileSourceId;
}

describe("readTailorInput", () => {
  it("refuses before any resume import", async () => {
    expect(await readTailorInput(db, candidateId, jobId)).toEqual({
      ok: false,
      error: { kind: "NoProfile" },
    });
  });

  it("refuses an unknown job id and a malformed one", async () => {
    await importProfile(candidateId);
    const unknown = await readTailorInput(db, candidateId, "00000000-0000-4000-8000-000000000000");
    const malformed = await readTailorInput(db, candidateId, "not-an-id");
    expect([unknown, malformed]).toEqual([
      { ok: false, error: { kind: "JobNotFound" } },
      { ok: false, error: { kind: "JobNotFound" } },
    ]);
  });

  it("refuses another candidate's job", async () => {
    const other = await seedApplication(db, "discovered");
    await importProfile(candidateId);
    expect(await readTailorInput(db, candidateId, other.jobId)).toEqual({
      ok: false,
      error: { kind: "JobNotFound" },
    });
  });

  it("returns the master in resume order and the job's fields", async () => {
    await importProfile(candidateId);
    const r = await readTailorInput(db, candidateId, jobId);
    if (!r.ok) throw new Error(r.error.kind);
    expect({
      roles: r.value.master.roles.map((x) => [x.employer, x.title, x.isCurrent]),
      atoms: r.value.master.atoms.map((a) => a.sourceQuote),
      skills: r.value.master.skills,
      job: [r.value.job.id, r.value.job.title],
    }).toEqual({
      roles: [["Example Corp", "Engineer", true]],
      atoms: ["Did synthetic thing number 1 in Go.", "Did synthetic thing number 2 in Go."],
      skills: ["Go"],
      job: [jobId, "Backend Engineer"],
    });
  });
});

describe("saveTailoredResume", () => {
  it("stores version 1, nothing for the same content, and version 2 for new toggles", async () => {
    await importProfile(candidateId);
    const source = await sourceId();
    const first = await save({}, source);
    const again = await save({}, source);
    const toggled = await save({ droppedSkills: ["Kubernetes"] }, source);
    expect([first, again, toggled]).toEqual([
      { version: 1, saved: true },
      { version: 1, saved: false },
      { version: 2, saved: true },
    ]);
  });

  it("stores a new version when the score changes for the same resume", async () => {
    await importProfile(candidateId);
    const source = await sourceId();
    await save({}, source);
    expect(await save({ score: { title: "exact" } }, source)).toEqual({ version: 2, saved: true });
  });

  it("reads versions newest first, with the toggles lowercased", async () => {
    await importProfile(candidateId);
    const source = await sourceId();
    await save({}, source);
    await save({ droppedSkills: ["Kubernetes", "kubernetes"] }, source);
    const versions = await readTailoredResumes(db, candidateId, jobId);
    expect(versions.map((v) => [v.version, v.droppedSkills])).toEqual([
      [2, ["kubernetes"]],
      [1, []],
    ]);
  });

  it("writes an event with ids, counts and flags and no resume or job text", async () => {
    await importProfile(candidateId);
    await save({}, await sourceId());
    const [event] = await db
      .select({ type: domainEvent.type, payload: domainEvent.payload, reason: domainEvent.reason })
      .from(domainEvent)
      .where(eq(domainEvent.type, "resume.tailored"));
    const text = JSON.stringify(event);
    expect([event?.type, text.includes("Secret Requirement"), text.includes("synthetic")]).toEqual([
      "resume.tailored",
      false,
      false,
    ]);
  });

  it("keeps versions to the candidate whose job it is", async () => {
    await importProfile(candidateId);
    await save({}, await sourceId());
    const other = await seedApplication(db, "discovered");
    expect(await readTailoredResumes(db, CandidateId.parse(other.candidateId), jobId)).toEqual([]);
  });

  it("refuses UPDATE, DELETE and TRUNCATE", async () => {
    await importProfile(candidateId);
    await save({}, await sourceId());
    expect([
      await sqlState(db.update(tailoredResume).set({ version: 9 })),
      await sqlState(db.delete(tailoredResume)),
      await sqlState(db.execute(sql`truncate tailored_resume`)),
    ]).toEqual([RESTRICT_VIOLATION, RESTRICT_VIOLATION, RESTRICT_VIOLATION]);
  });
});

describe("a draft job", () => {
  it("is refused by name", async () => {
    await importProfile(candidateId);
    const [draft] = await db
      .insert(job)
      .values({ candidateId, url: "https://jobs.example.com/draft", status: "draft" })
      .returning({ id: job.id });
    if (!draft) throw new Error("no draft");
    expect(await readTailorInput(db, candidateId, draft.id)).toEqual({
      ok: false,
      error: { kind: "JobNotReady" },
    });
  });
});
