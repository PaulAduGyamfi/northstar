import { CandidateId } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomLineEdit, resumeAudit, resumeAuditDecision } from "./audit-schema.js";
import {
  decideSuggestion,
  readAuditInput,
  readLatestAudit,
  rejectedKeys,
  type StoredSuggestion,
  saveResumeAudit,
} from "./audit-write.js";
import type { Db } from "./db.js";
import { PREFERENCE_DEFAULTS, savePreferences } from "./fit-write.js";
import { recordPostingCheck } from "./liveness-write.js";
import { experienceAtom } from "./profile-schema.js";
import { writeProfileImport } from "./profile-write.js";
import { domainEvent, job } from "./schema.js";
import { readTailorInput } from "./tailor-write.js";
import { createTestDb, seedApplication, sqlState } from "./test/pglite.js";

// Resume audits, decisions and edited lines (NS-190). Synthetic profile, job and lines only.

const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let jobId: string;

// One resume import: one role, two atoms. A different `textSha` supersedes the current import.
async function importProfile(owner: CandidateId, textSha = "e".repeat(64)): Promise<void> {
  await writeProfileImport(db, {
    candidateId: owner,
    fileName: "resume.txt",
    textSha256: textSha,
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

async function input() {
  const r = await readAuditInput(db, candidateId);
  if (!r) throw new Error("no import");
  return r;
}

// A run over the current import with one line suggestion per atom plus one term suggestion.
async function audit(): Promise<{ auditId: string; atomIds: string[]; source: string }> {
  const { profileSourceId, master } = await input();
  const atomIds = master.atoms.map((a) => a.id);
  const suggestions: StoredSuggestion[] = [
    ...atomIds.map((id) => ({
      id: `missing_metric:${id}`,
      kind: "missing_metric",
      dimension: "impact",
      target: { atomId: id },
      message: "What changed because of this? Add the result if you have it.",
    })),
    {
      id: "missing_keyword:kubernetes",
      kind: "missing_keyword",
      dimension: "keywords",
      target: { term: "Kubernetes" },
      message: "Kubernetes appears in your targets but nowhere in your resume.",
    },
  ];
  const { auditId } = await saveResumeAudit(db, {
    candidateId,
    profileSourceId,
    targets: ["Backend Engineer"],
    scores: { impact: 40, verbs: 90, ats: 100, length: 100, keywords: 50, consistency: 100 },
    overall: 80,
    pages: 1,
    suggestions,
  });
  return { auditId, atomIds, source: profileSourceId };
}

describe("readAuditInput", () => {
  it("is null before any resume import", async () => {
    expect(await readAuditInput(db, candidateId)).toBeNull();
  });

  it("targets the newest preference titles, then ready jobs' requirements, once each", async () => {
    await importProfile(candidateId);
    await savePreferences(db, {
      candidateId,
      values: { ...PREFERENCE_DEFAULTS, titles: ["Backend Engineer", "Platform Engineer"] },
      now: new Date(),
    });
    await db
      .update(job)
      .set({ requirements: ["Go", "Kubernetes", "go"] })
      .where(eq(job.id, jobId));
    expect((await input()).targets).toEqual([
      "Backend Engineer",
      "Platform Engineer",
      "Go",
      "Kubernetes",
    ]);
  });

  it("leaves a closed posting's requirements out of the targets", async () => {
    await importProfile(candidateId);
    await db
      .update(job)
      .set({ requirements: ["Kubernetes"] })
      .where(eq(job.id, jobId));
    const open = (await input()).targets;
    for (let i = 0; i < 2; i++) {
      await recordPostingCheck(db, { candidateId, jobId, ats: "greenhouse", outcome: "closed" });
    }
    expect([open, (await input()).targets]).toEqual([["Kubernetes"], []]);
  });
});

describe("saveResumeAudit and readLatestAudit", () => {
  it("stores a run and reads its suggestions back in order, with no decision yet", async () => {
    await importProfile(candidateId);
    const { auditId, atomIds } = await audit();
    const view = await readLatestAudit(db, candidateId);
    expect([
      view?.auditId,
      view?.overall,
      view?.suggestions.map((s) => [s.id, s.decision]),
    ]).toEqual([
      auditId,
      80,
      [
        [`missing_metric:${atomIds[0]}`, null],
        [`missing_metric:${atomIds[1]}`, null],
        ["missing_keyword:kubernetes", null],
      ],
    ]);
  });

  it("writes a resume.audited event with numbers only", async () => {
    await importProfile(candidateId);
    const { auditId } = await audit();
    const [event] = await db
      .select({ reason: domainEvent.reason, payload: domainEvent.payload })
      .from(domainEvent)
      .where(eq(domainEvent.type, "resume.audited"));
    expect(event).toEqual({
      reason: "Audited your resume: 80 overall, 3 suggestions",
      payload: expect.objectContaining({ auditId, overall: 80, suggestions: 3, targets: 1 }),
    });
    expect(JSON.stringify(event)).not.toContain("Kubernetes");
  });
});

describe("decideSuggestion", () => {
  it("accepting stores Paul's line as that atom's newest edit, and changes only that line", async () => {
    await importProfile(candidateId);
    const { auditId, atomIds } = await audit();
    const r = await decideSuggestion(db, {
      candidateId,
      auditId,
      key: `missing_metric:${atomIds[0]}`,
      decision: "accepted",
      newLine: "Cut synthetic thing number 1's latency in Go by half.",
    });
    expect(r.ok).toBe(true);
    const tailor = await readTailorInput(db, candidateId, jobId);
    if (!tailor.ok) throw new Error(tailor.error.kind);
    const quotes = await db
      .select({ q: experienceAtom.sourceQuote })
      .from(experienceAtom)
      .orderBy(experienceAtom.position);
    expect({
      tailor: tailor.value.master.atoms.map((a) => a.sourceQuote),
      audit: (await input()).master.atoms.map((a) => a.sourceQuote),
      stored: quotes.map((x) => x.q),
    }).toEqual({
      tailor: [
        "Cut synthetic thing number 1's latency in Go by half.",
        "Did synthetic thing number 2 in Go.",
      ],
      audit: [
        "Cut synthetic thing number 1's latency in Go by half.",
        "Did synthetic thing number 2 in Go.",
      ],
      // The imported quote, the provenance of the atom, never changes.
      stored: ["Did synthetic thing number 1 in Go.", "Did synthetic thing number 2 in Go."],
    });
  });

  it("uses the newest of two accepted lines for one atom", async () => {
    await importProfile(candidateId);
    const first = await audit();
    const key = `missing_metric:${first.atomIds[0]}`;
    await decideSuggestion(db, {
      candidateId,
      auditId: first.auditId,
      key,
      decision: "accepted",
      newLine: "Older line.",
    });
    const second = await audit();
    await decideSuggestion(db, {
      candidateId,
      auditId: second.auditId,
      key,
      decision: "accepted",
      newLine: "Newer line.",
    });
    expect((await input()).master.atoms[0]?.sourceQuote).toBe("Newer line.");
  });

  it("records the decision with its kind and no text in the event", async () => {
    await importProfile(candidateId);
    const { auditId, atomIds } = await audit();
    await decideSuggestion(db, {
      candidateId,
      auditId,
      key: `missing_metric:${atomIds[0]}`,
      decision: "accepted",
      newLine: "Cut synthetic thing number 1's latency in Go by half.",
    });
    const [event] = await db
      .select({ reason: domainEvent.reason, payload: domainEvent.payload })
      .from(domainEvent)
      .where(eq(domainEvent.type, "resume.suggestion_decided"));
    expect(event?.reason).toBe("You accepted a resume suggestion with your own line");
    expect(event?.payload).toEqual(
      expect.objectContaining({ auditId, kind: "missing_metric", decision: "accepted" }),
    );
    expect(JSON.stringify(event)).not.toMatch(/latency|synthetic|missing_metric:/);
  });

  it("leaves a rejected key out of rejectedKeys for a new import, and lists it for this one", async () => {
    await importProfile(candidateId);
    const { auditId, source } = await audit();
    await decideSuggestion(db, {
      candidateId,
      auditId,
      key: "missing_keyword:kubernetes",
      decision: "rejected",
    });
    const before = await rejectedKeys(db, candidateId, source);
    await importProfile(candidateId, "f".repeat(64));
    const newSource = (await input()).profileSourceId;
    expect([[...before], [...(await rejectedKeys(db, candidateId, newSource))]]).toEqual([
      ["missing_keyword:kubernetes"],
      [],
    ]);
  });

  it("refuses an unknown key, a second decision, a line on a term, an empty line and a stale audit", async () => {
    await importProfile(candidateId);
    const { auditId, atomIds } = await audit();
    const key = `missing_metric:${atomIds[0]}`;
    const results = [
      await decideSuggestion(db, { candidateId, auditId, key: "tense:nope", decision: "rejected" }),
      await decideSuggestion(db, { candidateId, auditId, key, decision: "rejected" }),
      await decideSuggestion(db, { candidateId, auditId, key, decision: "rejected" }),
      await decideSuggestion(db, {
        candidateId,
        auditId,
        key: "missing_keyword:kubernetes",
        decision: "accepted",
        newLine: "A line about Kubernetes.",
      }),
      await decideSuggestion(db, {
        candidateId,
        auditId,
        key: `missing_metric:${atomIds[1]}`,
        decision: "accepted",
        newLine: "   ",
      }),
    ];
    await importProfile(candidateId, "f".repeat(64));
    results.push(
      await decideSuggestion(db, {
        candidateId,
        auditId,
        key: `missing_metric:${atomIds[1]}`,
        decision: "rejected",
      }),
    );
    expect(results.map((r) => (r.ok ? "ok" : r.error.kind))).toEqual([
      "UnknownSuggestion",
      "ok",
      "AlreadyDecided",
      "NotALine",
      "EmptyLine",
      "StaleAudit",
    ]);
  });

  it("refuses a line with a line break, and the table refuses one written around it", async () => {
    await importProfile(candidateId);
    const { auditId, atomIds } = await audit();
    const key = `missing_metric:${atomIds[0]}`;
    const r = await decideSuggestion(db, {
      candidateId,
      auditId,
      key,
      decision: "accepted",
      newLine: "First line.\nSKILLS: Rust",
    });
    const direct = await sqlState(
      db.insert(resumeAuditDecision).values({
        candidateId,
        auditId,
        key,
        decision: "accepted",
        newLine: "First line.\nSKILLS: Rust",
      }),
    );
    expect([r, direct]).toEqual([{ ok: false, error: { kind: "MultiLine" } }, CHECK_VIOLATION]);
  });

  it("refuses another candidate's audit as unknown", async () => {
    await importProfile(candidateId);
    const { auditId, atomIds } = await audit();
    const other = CandidateId.parse((await seedApplication(db, "discovered")).candidateId);
    const r = await decideSuggestion(db, {
      candidateId: other,
      auditId,
      key: `missing_metric:${atomIds[0]}`,
      decision: "rejected",
    });
    expect(r).toEqual({ ok: false, error: { kind: "UnknownSuggestion" } });
  });
});

describe("append-only", () => {
  it("refuses UPDATE and DELETE on every audit table", async () => {
    await importProfile(candidateId);
    const { auditId, atomIds } = await audit();
    await decideSuggestion(db, {
      candidateId,
      auditId,
      key: `missing_metric:${atomIds[0]}`,
      decision: "accepted",
      newLine: "A new line.",
    });
    expect([
      await sqlState(db.update(resumeAudit).set({ overall: 1 })),
      await sqlState(db.delete(resumeAudit)),
      await sqlState(db.execute(sql`update resume_audit_suggestion set message = 'x'`)),
      await sqlState(db.delete(resumeAuditDecision)),
      await sqlState(db.update(atomLineEdit).set({ line: "edited" })),
      await sqlState(db.delete(atomLineEdit)),
    ]).toEqual(Array(6).fill(RESTRICT_VIOLATION));
  });
});
