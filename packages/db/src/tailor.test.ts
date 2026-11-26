import { createHash } from "node:crypto";
import { CandidateId } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { storedFile } from "./file-schema.js";
import { readStoredFile } from "./file-write.js";
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
const CHECK_VIOLATION = "23514";

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

// Synthetic bytes standing in for a rendered PDF: the database never parses them.
const PDF_A = new TextEncoder().encode("%PDF-1.7 synthetic render A");
const PDF_B = new TextEncoder().encode("%PDF-1.7 synthetic render B");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

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
    pdf: PDF_A,
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

describe("the tailored resume's PDF (NS-227)", () => {
  it("stores a new version's PDF and names it, and an unchanged save keeps the first PDF", async () => {
    await importProfile(candidateId);
    const source = await sourceId();
    await save({}, source);
    // Same content, a new render with other bytes (pdf-lib stamps a creation time).
    const again = await save({ pdf: PDF_B }, source);
    const [newest] = await readTailoredResumes(db, candidateId, jobId);
    expect([
      again,
      newest?.pdfSha256,
      await readStoredFile(db, candidateId, sha(PDF_A)),
      await readStoredFile(db, candidateId, sha(PDF_B)),
    ]).toEqual([{ version: 1, saved: false }, sha(PDF_A), PDF_A, null]);
  });

  it("stores the same PDF bytes once when two versions send them", async () => {
    await importProfile(candidateId);
    const source = await sourceId();
    await save({}, source);
    await save({ droppedSkills: ["Kubernetes"] }, source);
    const versions = await readTailoredResumes(db, candidateId, jobId);
    expect([
      versions.map((v) => v.pdfSha256),
      (await db.select({ id: storedFile.id }).from(storedFile)).length,
    ]).toEqual([[sha(PDF_A), sha(PDF_A)], 1]);
  });

  it("gives a version from before NS-227 a PDF when the same content is saved again", async () => {
    await importProfile(candidateId);
    const source = await sourceId();
    await save({}, source);
    const [first] = await db
      .select({ sha: tailoredResume.contentSha256 })
      .from(tailoredResume)
      .where(eq(tailoredResume.jobId, jobId));
    // A second job holding an older version: the same content, no PDF.
    const [older] = await db
      .insert(job)
      .values({
        candidateId,
        url: "https://jobs.example.com/older",
        // Its status doesn't matter to saveTailoredResume.
        status: "draft",
      })
      .returning({ id: job.id });
    if (!first || !older) throw new Error("setup");
    await db.insert(tailoredResume).values({
      candidateId,
      jobId: older.id,
      version: 1,
      profileSourceId: source,
      resume: {},
      validation: {},
      score: {},
      droppedSkills: [],
      contentSha256: first.sha,
    });
    const again = await save({ jobId: older.id }, source);
    const [newest] = await readTailoredResumes(db, candidateId, older.id);
    expect([again, newest?.pdfSha256]).toEqual([{ version: 2, saved: true }, sha(PDF_A)]);
  });

  it("puts the PDF's hash and size in the event, never its bytes", async () => {
    await importProfile(candidateId);
    await save({}, await sourceId());
    const [event] = await db
      .select({ payload: domainEvent.payload })
      .from(domainEvent)
      .where(eq(domainEvent.type, "resume.tailored"));
    const payload = event?.payload as Record<string, unknown> | undefined;
    expect([
      payload?.pdfSha256,
      payload?.pdfBytes,
      JSON.stringify(event).includes("synthetic render"),
    ]).toEqual([sha(PDF_A), PDF_A.byteLength, false]);
  });

  it("reads nothing for another candidate, an unknown hash or a malformed one", async () => {
    await importProfile(candidateId);
    await save({}, await sourceId());
    const other = await seedApplication(db, "discovered");
    expect([
      await readStoredFile(db, CandidateId.parse(other.candidateId), sha(PDF_A)),
      await readStoredFile(db, candidateId, "0".repeat(64)),
      await readStoredFile(db, candidateId, "not-a-hash"),
    ]).toEqual([null, null, null]);
  });

  it("stores nothing for an empty or oversize PDF", async () => {
    await importProfile(candidateId);
    const source = await sourceId();
    const empty = save({ pdf: new Uint8Array(0) }, source).catch((e: Error) => e.message);
    const big = save({ pdf: new Uint8Array(5 * 1024 * 1024 + 1) }, source).catch(
      (e: Error) => e.message,
    );
    expect([
      await empty,
      await big,
      await readTailoredResumes(db, candidateId, jobId),
      (await db.select({ id: storedFile.id }).from(storedFile)).length,
    ]).toEqual(["resume.tailor save failed", "resume.tailor save failed", [], 0]);
  });

  it("refuses a hash that isn't the bytes' own, another content type and over 5 MiB", async () => {
    const row = (over: Partial<typeof storedFile.$inferInsert>) =>
      db.insert(storedFile).values({
        candidateId,
        sha256: sha(PDF_A),
        contentType: "application/pdf",
        byteSize: PDF_A.byteLength,
        bytes: PDF_A,
        ...over,
      });
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    expect([
      await sqlState(row({ sha256: sha(PDF_B) })),
      await sqlState(row({ contentType: "text/html" })),
      await sqlState(row({ byteSize: PDF_A.byteLength + 1 })),
      await sqlState(row({ sha256: sha(big), byteSize: big.byteLength, bytes: big })),
    ]).toEqual([CHECK_VIOLATION, CHECK_VIOLATION, CHECK_VIOLATION, CHECK_VIOLATION]);
  });

  it("refuses UPDATE, DELETE and TRUNCATE on stored files", async () => {
    await importProfile(candidateId);
    await save({}, await sourceId());
    expect([
      await sqlState(db.update(storedFile).set({ contentType: "application/pdf" })),
      await sqlState(db.delete(storedFile)),
    ]).toEqual([RESTRICT_VIOLATION, RESTRICT_VIOLATION]);
  });

  it("refuses TRUNCATE on stored files by their own trigger", async () => {
    // CASCADE, since a plain TRUNCATE is refused first by tailored_resume's foreign key (0A000);
    // the message names the table, so tailored_resume's own trigger can't pass this for it.
    const message = await db.execute(sql`truncate stored_file cascade`).then(
      () => null,
      (e: { message?: string; cause?: { message?: string } }) => e.cause?.message ?? e.message,
    );
    expect(message).toBe("stored_file is append-only: TRUNCATE is not allowed");
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
