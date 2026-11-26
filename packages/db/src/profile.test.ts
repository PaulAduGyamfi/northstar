import { CandidateId } from "@northstar/domain";
import { eq, isNull, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { soleCandidate } from "./candidate.js";
import type { Db } from "./db.js";
import { readScoringProfile } from "./fit-write.js";
import {
  education,
  experienceAtom,
  profileLink,
  profileSource,
  role,
  skill,
} from "./profile-schema.js";
import {
  currentResumeHash,
  editLockedFact,
  type ProfileImportInput,
  readProfile,
  readSourceRoles,
  readThesisProfile,
  writeProfileImport,
} from "./profile-write.js";
import { candidate, domainEvent } from "./schema.js";
import { nextAtomForInterview } from "./story-write.js";
import { createTestDb, sqlState } from "./test/pglite.js";

const RESTRICT_VIOLATION = "23001";
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

// The single row a query must return; fails the test loudly instead of using `!`.
function one<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error("expected a row");
  return row;
}

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

// A synthetic, already-validated extraction (invented employer, example.com links).
const extract = (
  overrides: Partial<ProfileImportInput["extract"]> = {},
): ProfileImportInput["extract"] => ({
  roles: [
    {
      key: "r1",
      employer: "Example Payments",
      title: "Senior Engineer",
      startMonth: "2021-03",
      endMonth: null,
      current: true,
    },
  ],
  education: [
    {
      school: "Example State University",
      degree: "BSc",
      field: "Computer Science",
      startMonth: null,
      endMonth: "2015-06",
    },
  ],
  atoms: [
    {
      roleKey: "r1",
      what: "Made payment retries idempotent",
      how: ["Go", "Postgres"],
      impact: "cut duplicate charges to zero",
      scope: null,
      startMonth: null,
      endMonth: null,
      sourceQuote:
        "Made payment retries idempotent in Go and Postgres, cutting duplicate charges to zero.",
      evidenceLink: null,
    },
  ],
  skills: ["Go", "Postgres"],
  certifications: [
    { name: "Example Cloud Associate", issuer: "Example Cloud", issuedMonth: "2023-01" },
  ],
  links: [{ label: "Portfolio", url: "https://portfolio.example.com" }],
  ...overrides,
});

const importInput = (sha = SHA_A, x = extract()): ProfileImportInput => ({
  candidateId,
  fileName: "resume.pdf",
  textSha256: sha,
  promptVersion: 1,
  model: "claude-opus-5-5",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  call: { inputTokens: 2000, outputTokens: 900, costUsd: 0.026 },
  extract: x,
});

describe("writeProfileImport", () => {
  it("writes the source, roles, education, atoms, skills, certifications and links in one go", async () => {
    const report = await writeProfileImport(db, importInput());
    expect(report).toMatchObject({
      status: "imported",
      counts: { roles: 1, education: 1, atoms: 1, skills: 2, certifications: 1, links: 1 },
    });
    const [atom] = await db.select().from(experienceAtom);
    const r = one(await db.select().from(role));
    expect(atom?.roleId).toBe(r?.id);
    expect(atom?.sourceQuote).toContain("idempotent");
    expect(r?.locked).toBe(true);
  });

  it("appends one profile.imported event with counts and no resume text", async () => {
    await writeProfileImport(db, importInput());
    const events = await db.select().from(domainEvent);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("profile.imported");
    expect(events[0]?.payload).toEqual({
      promptVersion: 1,
      model: "claude-opus-5-5",
      counts: { roles: 1, education: 1, atoms: 1, skills: 2, certifications: 1, links: 1 },
      call: { inputTokens: 2000, outputTokens: 900, costUsd: 0.026 },
    });
    expect(events[0]?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    // position is a bigint, which JSON can't hold; everything else is checked for resume text.
    const { position: _position, ...stored } = one(events);
    expect(JSON.stringify(stored)).not.toContain("idempotent");
    expect(JSON.stringify(stored)).not.toContain("Example Payments");
  });

  it("importing the same text twice writes nothing the second time", async () => {
    const first = await writeProfileImport(db, importInput());
    const second = await writeProfileImport(db, importInput());
    expect(second).toEqual({ status: "unchanged", sourceId: first.sourceId });
    expect((await db.select().from(profileSource)).length).toBe(1);
    expect((await db.select().from(experienceAtom)).length).toBe(1);
    expect((await db.select().from(domainEvent)).length).toBe(1);
  });

  it("a forced re-import of the same text supersedes the previous source", async () => {
    const first = await writeProfileImport(db, importInput());
    const second = await writeProfileImport(db, { ...importInput(), force: true });
    expect(second.status).toBe("imported");
    expect(second.sourceId).not.toBe(first.sourceId);
    const current = (await db.select().from(profileSource)).filter(
      (src) => src.supersededAt === null,
    );
    expect(current.map((src) => src.id)).toEqual([second.sourceId]);
  });

  it("a new resume version supersedes the previous source", async () => {
    const first = await writeProfileImport(db, importInput(SHA_A));
    const second = await writeProfileImport(db, importInput(SHA_B));
    expect(second.status).toBe("imported");
    const sources = await db.select().from(profileSource);
    const old = sources.find((s) => s.id === first.sourceId);
    const current = sources.filter((s) => s.supersededAt === null);
    expect(old?.supersededAt).not.toBeNull();
    expect(current.map((s) => s.id)).toEqual([second.sourceId]);
  });

  it("refuses an atom that points at a role key the import doesn't have, writing nothing", async () => {
    const bad = extract({
      atoms: [{ ...one(extract().atoms), roleKey: "missing" }],
    });
    await expect(writeProfileImport(db, importInput(SHA_A, bad))).rejects.toThrow(
      "atom 0 points at unknown role key",
    );
    expect((await db.select().from(profileSource)).length).toBe(0);
    expect((await db.select().from(domainEvent)).length).toBe(0);
  });
});

describe("LinkedIn imports (NS-133)", () => {
  const linkedin = (sha = SHA_B): ProfileImportInput => ({
    ...importInput(sha),
    kind: "linkedin",
    fileName: "linkedin-export",
    promptVersion: 0,
    model: "none",
  });

  it("keeps a LinkedIn import beside the resume, superseding neither", async () => {
    await writeProfileImport(db, importInput());
    await writeProfileImport(db, linkedin());
    const sources = await db
      .select({ kind: profileSource.kind, supersededAt: profileSource.supersededAt })
      .from(profileSource);
    expect(sources.map((s) => [s.kind, s.supersededAt])).toEqual([
      ["resume", null],
      ["linkedin", null],
    ]);
  });

  it("re-importing the same export is a no-op, and a changed one supersedes only LinkedIn", async () => {
    const resume = await writeProfileImport(db, importInput());
    const first = await writeProfileImport(db, linkedin());
    expect(await writeProfileImport(db, linkedin())).toEqual({
      status: "unchanged",
      sourceId: first.sourceId,
    });
    await writeProfileImport(db, linkedin(SHA_C));
    const current = await db
      .select({ id: profileSource.id, kind: profileSource.kind })
      .from(profileSource)
      .where(isNull(profileSource.supersededAt));
    expect(current.map((c) => c.kind).sort()).toEqual(["linkedin", "resume"]);
    expect(current.some((c) => c.id === resume.sourceId)).toBe(true);
  });

  it("reads the roles of the current import of one kind, or null before one", async () => {
    await writeProfileImport(db, importInput());
    expect(await readSourceRoles(db, candidateId, "linkedin")).toBeNull();
    await writeProfileImport(db, linkedin());
    expect(await readSourceRoles(db, candidateId, "linkedin")).toEqual([
      {
        employer: "Example Payments",
        title: "Senior Engineer",
        startMonth: "2021-03",
        endMonth: null,
        current: true,
      },
    ]);
  });

  it("names the kind in its event and keeps the resume reader on the resume", async () => {
    await writeProfileImport(db, linkedin());
    const [event] = await db.select().from(domainEvent);
    expect([event?.reason, (event?.payload as { kind?: string } | undefined)?.kind]).toEqual([
      "LinkedIn export imported into the profile graph",
      "linkedin",
    ]);
    expect([
      await readProfile(db, candidateId),
      await readThesisProfile(db, candidateId),
      await readScoringProfile(db, candidateId),
      await nextAtomForInterview(db, candidateId),
    ]).toEqual([null, null, null, null]);
  });
});

describe("personal site imports (NS-209)", () => {
  const site = (sha = SHA_C): ProfileImportInput => ({
    ...importInput(sha, {
      ...extract(),
      roles: [],
      education: [],
      skills: [],
      certifications: [],
      // A site claim: no role, its project's link as evidence.
      atoms: [
        {
          roleKey: null,
          what: "Built a budgeting app used by 40 testers",
          how: [],
          impact: null,
          scope: null,
          startMonth: null,
          endMonth: null,
          sourceQuote: "Built a budgeting app used by 40 testers",
          evidenceLink: "https://example.com/ledgerline",
        },
      ],
      links: [{ label: "Ledgerline", url: "https://example.com/ledgerline" }],
    }),
    kind: "site",
    fileName: "site.md",
    promptVersion: 0,
    model: "none",
  });

  it("keeps a site import beside the resume and LinkedIn, and supersedes only an earlier site", async () => {
    await writeProfileImport(db, importInput());
    await writeProfileImport(db, { ...importInput(SHA_B), kind: "linkedin", fileName: "li" });
    await writeProfileImport(db, site());
    await writeProfileImport(db, site("d".repeat(64)));
    const current = await db
      .select({ kind: profileSource.kind })
      .from(profileSource)
      .where(isNull(profileSource.supersededAt));
    expect(current.map((c) => c.kind).sort()).toEqual(["linkedin", "resume", "site"]);
  });

  it("stores its claims with no role and the project's link, and the same file again stores nothing", async () => {
    const first = await writeProfileImport(db, site());
    const again = await writeProfileImport(db, site());
    const atoms = await db
      .select({ roleId: experienceAtom.roleId, link: experienceAtom.evidenceLink })
      .from(experienceAtom);
    expect([again, atoms]).toEqual([
      { status: "unchanged", sourceId: first.sourceId },
      [{ roleId: null, link: "https://example.com/ledgerline" }],
    ]);
  });

  it("leaves the resume reader on the resume's atoms when both are imported", async () => {
    await writeProfileImport(db, importInput());
    await writeProfileImport(db, site());
    const profile = await readProfile(db, candidateId);
    const shown = [
      ...(profile?.roles.flatMap((r) => r.atoms) ?? []),
      ...(profile?.unassignedAtoms ?? []),
    ];
    expect([shown.includes("Built a budgeting app used by 40 testers"), shown.length]).toEqual([
      false,
      extract().atoms.length,
    ]);
  });

  it("names the site in its event and keeps the resume reader on the resume", async () => {
    await writeProfileImport(db, site());
    const [event] = await db.select().from(domainEvent);
    expect([
      event?.reason,
      (event?.payload as { kind?: string } | undefined)?.kind,
      await readProfile(db, candidateId),
    ]).toEqual(["Personal site imported into the profile graph", "site", null]);
  });
});

describe("database guards for the profile", () => {
  it("every profile row needs a real candidate", async () => {
    await writeProfileImport(db, importInput());
    const s = one(await db.select().from(profileSource));
    const ghost = "33333333-3333-4333-8333-333333333333";
    expect(
      await sqlState(
        db.insert(role).values({
          candidateId: CandidateId.parse(ghost),
          sourceId: s.id,
          employer: "Example Co",
          title: "Engineer",
          position: 9,
        }),
      ),
    ).toBe(FOREIGN_KEY_VIOLATION);
  });

  it("a row can't point at another candidate's source", async () => {
    await writeProfileImport(db, importInput());
    const s = one(await db.select().from(profileSource));
    const [other] = await db.insert(candidate).values({ displayName: "Other" }).returning();
    expect(
      await sqlState(
        db
          .insert(skill)
          .values({ candidateId: CandidateId.parse(other?.id), sourceId: s.id, name: "Go" }),
      ),
    ).toBe(FOREIGN_KEY_VIOLATION);
  });

  it("only one current resume source per candidate", async () => {
    await writeProfileImport(db, importInput());
    const code = await sqlState(
      db.insert(profileSource).values({
        candidateId,
        kind: "resume",
        fileName: "other.pdf",
        textSha256: SHA_B,
      }),
    );
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it("rejects changing a locked role's employer", async () => {
    await writeProfileImport(db, importInput());
    const code = await sqlState(db.update(role).set({ employer: "Somewhere Grander" }));
    expect(code).toBe(RESTRICT_VIOLATION);
  });

  it("rejects changing a locked role's title or dates", async () => {
    await writeProfileImport(db, importInput());
    expect(await sqlState(db.update(role).set({ title: "Principal Engineer" }))).toBe(
      RESTRICT_VIOLATION,
    );
    expect(await sqlState(db.update(role).set({ startMonth: "2019-01" }))).toBe(RESTRICT_VIOLATION);
    expect(await sqlState(db.update(role).set({ endMonth: "2024-01" }))).toBe(RESTRICT_VIOLATION);
  });

  it("rejects flipping a locked role's current flag", async () => {
    await writeProfileImport(db, importInput());
    expect(await sqlState(db.update(role).set({ isCurrent: false }))).toBe(RESTRICT_VIOLATION);
  });

  it("stores a year-only date and rejects a date that isn't YYYY or YYYY-MM", async () => {
    await writeProfileImport(db, importInput());
    const r = one(await db.select().from(role));
    const insert = (startMonth: string) =>
      sqlState(
        db.insert(role).values({
          candidateId,
          sourceId: r.sourceId,
          employer: "Example Co",
          title: "Engineer",
          startMonth,
          position: 1,
        }),
      );
    expect(await insert("2019")).toBeNull();
    expect(await insert("19")).toBe("23514");
  });

  it("rejects unlocking a locked role or deleting it", async () => {
    await writeProfileImport(db, importInput());
    expect(await sqlState(db.update(role).set({ locked: false }))).toBe(RESTRICT_VIOLATION);
    expect(await sqlState(db.delete(role))).toBe(RESTRICT_VIOLATION);
  });

  it("rejects moving a locked role to another source", async () => {
    await writeProfileImport(db, importInput(SHA_A));
    await writeProfileImport(db, importInput(SHA_B));
    const current = one(
      (await db.select().from(profileSource)).filter((src) => src.supersededAt === null),
    );
    const oldRole = one((await db.select().from(role)).filter((r) => r.sourceId !== current.id));
    expect(
      await sqlState(db.update(role).set({ sourceId: current.id }).where(eq(role.id, oldRole.id))),
    ).toBe(RESTRICT_VIOLATION);
  });

  it("rejects changing a locked degree or school", async () => {
    await writeProfileImport(db, importInput());
    expect(await sqlState(db.update(education).set({ degree: "PhD" }))).toBe(RESTRICT_VIOLATION);
    expect(await sqlState(db.update(education).set({ school: "Elsewhere" }))).toBe(
      RESTRICT_VIOLATION,
    );
  });

  it("rejects a date written as words instead of YYYY or YYYY-MM", async () => {
    await writeProfileImport(db, importInput());
    const r = one(await db.select().from(role));
    const code = await sqlState(
      db.insert(role).values({
        candidateId,
        sourceId: r.sourceId,
        employer: "Example Co",
        title: "Engineer",
        startMonth: "March 2020",
        position: 1,
      }),
    );
    expect(code).toBe("23514");
  });

  it("rejects a link that isn't http(s)", async () => {
    await writeProfileImport(db, importInput());
    const s = one(await db.select().from(profileSource));
    const code = await sqlState(
      db
        .insert(profileLink)
        .values({ candidateId, sourceId: s.id, label: "x", url: "javascript:alert(1)" }),
    );
    expect(code).toBe("23514");
  });

  it("keeps a skill name unique within one source", async () => {
    await writeProfileImport(db, importInput());
    const s = one(await db.select().from(profileSource));
    const code = await sqlState(
      db.insert(skill).values({ candidateId, sourceId: s.id, name: "Go" }),
    );
    expect(code).toBe(UNIQUE_VIOLATION);
  });
});

describe("editLockedFact", () => {
  it("lets Paul change a locked fact himself and records which fields changed", async () => {
    await writeProfileImport(db, importInput());
    const r = one(await db.select().from(role));
    const result = await editLockedFact(db, {
      candidateId,
      table: "role",
      id: r.id,
      changes: { startMonth: "2021-04" },
      reason: "Official HR start date",
      idempotencyKey: "edit-1",
    });
    expect(result.ok).toBe(true);
    const [after] = await db.select().from(role).where(eq(role.id, r.id));
    expect(after?.startMonth).toBe("2021-04");
    const events = await db
      .select()
      .from(domainEvent)
      .where(eq(domainEvent.type, "profile.locked_fact_edited"));
    expect(events.map((e) => e.payload)).toEqual([{ table: "role", fields: ["startMonth"] }]);
    expect(events[0]?.actor).toBe("user");
  });

  it("lets Paul mark a role as no longer current, with its end date, in one edit", async () => {
    await writeProfileImport(db, importInput());
    const r = one(await db.select().from(role));
    const result = await editLockedFact(db, {
      candidateId,
      table: "role",
      id: r.id,
      changes: { isCurrent: false, endMonth: "2026-02" },
      reason: "Left the company",
      idempotencyKey: "edit-current",
    });
    expect(result.ok).toBe(true);
    const [after] = await db.select().from(role).where(eq(role.id, r.id));
    expect([after?.isCurrent, after?.endMonth]).toEqual([false, "2026-02"]);
    const events = await db
      .select()
      .from(domainEvent)
      .where(eq(domainEvent.type, "profile.locked_fact_edited"));
    expect(events.map((e) => e.payload)).toEqual([
      { table: "role", fields: ["isCurrent", "endMonth"] },
    ]);
  });

  it("refuses a role that is current and also has an end date, even through editLockedFact", async () => {
    await writeProfileImport(db, importInput());
    const r = one(await db.select().from(role));
    const edit = editLockedFact(db, {
      candidateId,
      table: "role",
      id: r.id,
      changes: { endMonth: "2026-02" },
      reason: "End date without clearing current",
      idempotencyKey: "edit-both",
    });
    expect(await sqlState(edit)).toBe("23514");
  });

  it("leaves the unlock setting off after the edit, so later updates are still refused", async () => {
    await writeProfileImport(db, importInput());
    const r = one(await db.select().from(role));
    await editLockedFact(db, {
      candidateId,
      table: "role",
      id: r.id,
      changes: { title: "Staff Engineer" },
      reason: "Promotion on the HR record",
      idempotencyKey: "edit-2",
    });
    expect(await sqlState(db.update(role).set({ title: "Anything" }))).toBe(RESTRICT_VIOLATION);
    const setting = await db.execute(
      sql`select current_setting('northstar.locked_edit', true) as v`,
    );
    expect((setting as { rows: { v: string | null }[] }).rows[0]?.v ?? "").toBe("");
  });

  it("refuses a field that isn't a locked fact", async () => {
    await writeProfileImport(db, importInput());
    const r = one(await db.select().from(role));
    const result = await editLockedFact(db, {
      candidateId,
      table: "role",
      id: r.id,
      changes: { locked: false } as never,
      reason: "x",
      idempotencyKey: "edit-3",
    });
    expect(result).toEqual({ ok: false, error: { kind: "NotALockedFact", fields: ["locked"] } });
  });
});

describe("helpers", () => {
  it("currentResumeHash is null before an import and the text hash after", async () => {
    expect(await currentResumeHash(db, candidateId)).toBeNull();
    await writeProfileImport(db, importInput(SHA_A));
    expect(await currentResumeHash(db, candidateId)).toBe(SHA_A);
  });

  it("soleCandidate returns the one candidate and refuses to guess between two", async () => {
    expect(await soleCandidate(db)).toBe(candidateId);
    await db.insert(candidate).values({ displayName: "Second" });
    await expect(soleCandidate(db)).rejects.toThrow("more than one candidate");
  });
});

describe("readProfile", () => {
  it("lists roles and atoms in resume order, not by insert time", async () => {
    const base = extract();
    const atom = one(base.atoms);
    const x = extract({
      roles: [
        {
          key: "r1",
          employer: "Zeta Example",
          title: "Engineer",
          startMonth: null,
          endMonth: null,
          current: false,
        },
        {
          key: "r2",
          employer: "Alpha Example",
          title: "Engineer",
          startMonth: "2019",
          endMonth: null,
          current: false,
        },
      ],
      atoms: [
        { ...atom, roleKey: "r1", what: "Third thing" },
        { ...atom, roleKey: "r1", what: "First thing" },
        { ...atom, roleKey: "r2", what: "Second thing" },
      ],
    });
    await writeProfileImport(db, importInput(SHA_A, x));
    const view = await readProfile(db, candidateId);
    expect(view?.roles.map((r) => [r.employer, r.atoms])).toEqual([
      ["Zeta Example", ["Third thing", "First thing"]],
      ["Alpha Example", ["Second thing"]],
    ]);
  });

  it("is null before any import", async () => {
    expect(await readProfile(db, candidateId)).toBeNull();
  });

  it("shows the current source's roles with their atoms and skills", async () => {
    await writeProfileImport(db, importInput());
    expect(await readProfile(db, candidateId)).toEqual({
      roles: [
        {
          employer: "Example Payments",
          title: "Senior Engineer",
          startMonth: "2021-03",
          endMonth: null,
          current: true,
          atoms: ["Made payment retries idempotent"],
        },
      ],
      unassignedAtoms: [],
      skills: ["Go", "Postgres"],
    });
  });
});

describe("readThesisProfile (NS-152)", () => {
  it("is null before any resume import", async () => {
    expect(await readThesisProfile(db, candidateId)).toBeNull();
  });

  it("gives the roles' locked dates, each atom's id and verbatim quote, and the skills", async () => {
    await writeProfileImport(db, importInput());
    const p = await readThesisProfile(db, candidateId);
    expect([p?.roles, p?.atoms.map((a) => [typeof a.id, a.quote]), p?.skills]).toEqual([
      [
        {
          employer: "Example Payments",
          title: "Senior Engineer",
          startMonth: "2021-03",
          endMonth: null,
          current: true,
        },
      ],
      [
        [
          "string",
          "Made payment retries idempotent in Go and Postgres, cutting duplicate charges to zero.",
        ],
      ],
      ["Go", "Postgres"],
    ]);
  });
});
