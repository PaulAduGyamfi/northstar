import { CandidateId } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { fitScore, searchPreference } from "./fit-schema.js";
import { type ApplicationFilter, listApplications } from "./pipeline-read.js";
import { profileSource } from "./profile-schema.js";
import { application, candidate, company, job } from "./schema.js";
import { createTestDb } from "./test/pglite.js";

// Pipeline filters and fit scores (NS-207, DSH-001) on PGlite. Invented companies only.

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let preferenceId: string;
let sourceId: string;
let fingerprints = 0;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const [c] = await db.insert(candidate).values({ displayName: "Test Candidate" }).returning();
  if (!c) throw new Error("no candidate");
  candidateId = CandidateId.parse(c.id);
  const [p] = await db.insert(searchPreference).values({ candidateId, version: 1 }).returning();
  const [s] = await db
    .insert(profileSource)
    .values({ candidateId, kind: "resume", fileName: "resume.md", textSha256: "c".repeat(64) })
    .returning();
  if (!p || !s) throw new Error("no preference or source");
  preferenceId = p.id;
  sourceId = s.id;
});

afterEach(async () => {
  await close();
});

// One application on a new job, with its company, ATS, creation time and fit scores (oldest
// first).
async function app(opts: {
  company: string;
  ats: string | null;
  created: string;
  scores?: { score: number; band: "queue" | "suggest" | "skip"; at: string }[];
}): Promise<string> {
  const [co] = await db.insert(company).values({ candidateId, name: opts.company }).returning();
  const [j] = await db
    .insert(job)
    .values({
      candidateId,
      companyId: co?.id ?? null,
      title: "Engineer",
      url: `https://jobs.example.com/${opts.company}`,
      ats: opts.ats,
    })
    .returning();
  if (!j) throw new Error("no job");
  for (const s of opts.scores ?? []) {
    fingerprints++;
    await db.insert(fitScore).values({
      candidateId,
      jobId: j.id,
      preferenceId,
      profileSourceId: sourceId,
      jobFingerprint: fingerprints.toString(16).padStart(64, "0"),
      score: s.score,
      band: s.band,
      reason: "fit",
      stretch: false,
      components: {},
      evidence: {},
      method: "rules",
      scoredAt: new Date(s.at),
    });
  }
  const [a] = await db
    .insert(application)
    .values({ candidateId, jobId: j.id, status: "queued", createdAt: new Date(opts.created) })
    .returning();
  if (!a) throw new Error("no application");
  return opts.company;
}

const companies = async (filter: ApplicationFilter) =>
  (await listApplications(db, candidateId, filter)).map((a) => a.company).sort();

beforeEach(async () => {
  await app({
    company: "Globex",
    ats: "greenhouse",
    created: "2026-11-01T10:00:00Z",
    scores: [
      { score: 70, band: "suggest", at: "2026-11-01T09:00:00Z" },
      { score: 90, band: "queue", at: "2026-11-02T09:00:00Z" },
    ],
  });
  await app({
    company: "Initech",
    ats: "lever",
    created: "2026-11-10T23:59:00Z",
    scores: [{ score: 40, band: "skip", at: "2026-11-10T09:00:00Z" }],
  });
  await app({ company: "Hooli Labs", ats: null, created: "2026-11-20T00:00:00Z" });
});

describe("listApplications filters", () => {
  it("gives each row its job's newest fit score and band, or null while unscored", async () => {
    const rows = await listApplications(db, candidateId);
    const byCompany = Object.fromEntries(rows.map((r) => [r.company, [r.fitScore, r.fitBand]]));
    expect(byCompany).toEqual({
      Globex: [90, "queue"],
      Initech: [40, "skip"],
      "Hooli Labs": [null, null],
    });
  });

  it("narrows by part of the company name, ignoring case", async () => {
    expect(await companies({ company: "hooli" })).toEqual(["Hooli Labs"]);
  });

  it("narrows by the newest fit band only", async () => {
    expect([await companies({ band: "queue" }), await companies({ band: "suggest" })]).toEqual([
      ["Globex"],
      [],
    ]);
  });

  it("narrows by the job's ATS, or other for none", async () => {
    expect([await companies({ source: "lever" }), await companies({ source: "other" })]).toEqual([
      ["Initech"],
      ["Hooli Labs"],
    ]);
  });

  it("narrows by creation day, both ends inclusive in UTC", async () => {
    expect([
      await companies({ from: "2026-11-10", to: "2026-11-10" }),
      await companies({ from: "2026-11-11" }),
      await companies({ to: "2026-11-09" }),
    ]).toEqual([["Initech"], ["Hooli Labs"], ["Globex"]]);
  });

  it("combines filters", async () => {
    expect(await companies({ source: "greenhouse", band: "skip" })).toEqual([]);
  });

  it("treats a name with SQL wildcards as plain text", async () => {
    expect(await companies({ company: "%" })).toEqual([]);
  });

  it("never lists another candidate's applications through a filter", async () => {
    const [other] = await db.insert(candidate).values({ displayName: "Other" }).returning();
    const otherId = other?.id ?? "";
    const [co] = await db
      .insert(company)
      .values({ candidateId: otherId, name: "Soylent" })
      .returning();
    const [j] = await db
      .insert(job)
      .values({
        candidateId: otherId,
        companyId: co?.id ?? null,
        title: "Engineer",
        url: "https://jobs.example.com/s",
      })
      .returning();
    await db
      .insert(application)
      .values({ candidateId: otherId, jobId: j?.id ?? "", status: "queued" });
    expect(await companies({ company: "o" })).toEqual(["Globex", "Hooli Labs"]);
  });
});
