import { randomUUID } from "node:crypto";
import { type CandidateId, err, ok, type Result } from "@northstar/domain";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "./db.js";
import {
  certification,
  education,
  experienceAtom,
  profileLink,
  profileSource,
  role,
  skill,
} from "./profile-schema.js";
import { domainEvent } from "./schema.js";

type Month = string | null;

// A validated extraction ready to store. packages/profile builds it after the provenance check;
// this package only stores it, so it has no dependency on the LLM or its schema.
export type ProfileImportInput = {
  candidateId: CandidateId;
  fileName: string;
  textSha256: string;
  promptVersion: number;
  model: string;
  // The active span's trace id and the gateway's call record (ids and numbers, no text), so the
  // feed can link the import to its trace and cost (OBS-001, OBV-003).
  traceId: string | null;
  call: Record<string, unknown>;
  // Re-import even when the text is unchanged (a better prompt, a fixed extraction). Supersedes
  // the current source like a new version would.
  force?: boolean;
  extract: {
    roles: {
      key: string;
      employer: string;
      title: string;
      startMonth: Month;
      endMonth: Month;
      current: boolean;
    }[];
    education: {
      school: string;
      degree: string | null;
      field: string | null;
      startMonth: Month;
      endMonth: Month;
    }[];
    atoms: {
      roleKey: string | null;
      what: string;
      how: string[];
      impact: string | null;
      scope: string | null;
      startMonth: Month;
      endMonth: Month;
      sourceQuote: string;
      evidenceLink: string | null;
    }[];
    skills: string[];
    certifications: { name: string; issuer: string | null; issuedMonth: Month }[];
    links: { label: string; url: string }[];
  };
};

export type ProfileCounts = {
  roles: number;
  education: number;
  atoms: number;
  skills: number;
  certifications: number;
  links: number;
};

export type ImportReport =
  | { status: "imported"; sourceId: string; counts: ProfileCounts }
  | { status: "unchanged"; sourceId: string };

// Stores one resume import in a single transaction (ADR-0012 style): the source, every row, and
// one profile.imported event with counts only (no resume text, OBS-001). Importing the same text
// again changes nothing (RES-006); a different text supersedes the current resume source.
export async function writeProfileImport(db: Db, input: ProfileImportInput): Promise<ImportReport> {
  const x = input.extract;
  // Check role references before touching the database, so a bad extraction writes nothing.
  const roleKeys = new Set(x.roles.map((r) => r.key));
  x.atoms.forEach((atom, i) => {
    if (atom.roleKey !== null && !roleKeys.has(atom.roleKey)) {
      throw new Error(`atom ${i} points at unknown role key`);
    }
  });
  // Skills are unique per source; the same skill twice in one resume is one skill.
  const skills = [...new Set(x.skills.map((s) => s.trim()).filter(Boolean))];

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(profileSource)
      .where(
        and(
          eq(profileSource.candidateId, input.candidateId),
          eq(profileSource.kind, "resume"),
          isNull(profileSource.supersededAt),
        ),
      );
    if (current && current.textSha256 === input.textSha256 && !input.force) {
      return { status: "unchanged", sourceId: current.id } as const;
    }
    if (current) {
      await tx
        .update(profileSource)
        .set({ supersededAt: sql`now()` })
        .where(eq(profileSource.id, current.id));
    }

    const [source] = await tx
      .insert(profileSource)
      .values({
        candidateId: input.candidateId,
        kind: "resume",
        fileName: input.fileName,
        textSha256: input.textSha256,
      })
      .returning();
    if (!source) throw new Error("profile_source insert returned no row");
    const base = { candidateId: input.candidateId, sourceId: source.id };

    // Roles first, so atoms can point at them by the extraction's role key.
    const roleIds = new Map<string, string>();
    for (const [position, r] of x.roles.entries()) {
      const [row] = await tx
        .insert(role)
        .values({
          ...base,
          employer: r.employer,
          title: r.title,
          startMonth: r.startMonth,
          endMonth: r.endMonth,
          isCurrent: r.current,
          position,
        })
        .returning({ id: role.id });
      if (!row) throw new Error("role insert returned no row");
      roleIds.set(r.key, row.id);
    }
    if (x.education.length > 0) {
      await tx.insert(education).values(x.education.map((e) => ({ ...base, ...e })));
    }
    if (x.atoms.length > 0) {
      await tx.insert(experienceAtom).values(
        x.atoms.map(({ roleKey, ...atom }, position) => ({
          ...base,
          ...atom,
          position,
          roleId: roleKey === null ? null : (roleIds.get(roleKey) ?? null),
        })),
      );
    }
    if (skills.length > 0) {
      await tx.insert(skill).values(skills.map((name) => ({ ...base, name })));
    }
    if (x.certifications.length > 0) {
      await tx.insert(certification).values(x.certifications.map((c) => ({ ...base, ...c })));
    }
    if (x.links.length > 0) {
      await tx.insert(profileLink).values(x.links.map((l) => ({ ...base, ...l })));
    }

    const counts: ProfileCounts = {
      roles: x.roles.length,
      education: x.education.length,
      atoms: x.atoms.length,
      skills: skills.length,
      certifications: x.certifications.length,
      links: x.links.length,
    };
    await tx.insert(domainEvent).values({
      id: randomUUID(),
      candidateId: input.candidateId,
      aggregate: `candidate:${input.candidateId}`,
      type: "profile.imported",
      actor: "agent:profile-import",
      reason: "Resume imported into the profile graph",
      inputsSummary: `resume source ${source.id}`,
      payload: {
        promptVersion: input.promptVersion,
        model: input.model,
        counts,
        call: input.call,
      },
      links: [],
      traceId: input.traceId,
      idempotencyKey: `profile-import:${source.id}`,
      occurredAt: new Date(),
    });
    return { status: "imported", sourceId: source.id, counts } as const;
  });
}

// The locked facts (CPG-004), per table. Only these fields may change through editLockedFact.
const LOCKED_FIELDS = {
  role: ["employer", "title", "startMonth", "endMonth", "isCurrent"],
  education: ["school", "degree", "field", "startMonth", "endMonth"],
} as const;

type LockedTable = keyof typeof LOCKED_FIELDS;

export type EditLockedFactInput = {
  candidateId: CandidateId;
  table: LockedTable;
  id: string;
  changes: Partial<Record<(typeof LOCKED_FIELDS)[LockedTable][number], string | boolean | null>>;
  reason: string;
  idempotencyKey: string;
};

export type EditLockedFactError =
  | { kind: "NotALockedFact"; fields: string[] }
  | { kind: "NotFound"; id: string };

// Paul's own edit of a locked fact (an official HR date, a corrected title). The only code path
// that sets northstar.locked_edit; set_config(..., true) scopes it to this transaction, so the
// unlock ends when the transaction does. Generators never call this.
export async function editLockedFact(
  db: Db,
  input: EditLockedFactInput,
): Promise<Result<{ fields: string[] }, EditLockedFactError>> {
  const allowed: readonly string[] = LOCKED_FIELDS[input.table];
  const fields = Object.keys(input.changes);
  const notLocked = fields.filter((f) => !allowed.includes(f));
  if (notLocked.length > 0 || fields.length === 0) {
    return err({ kind: "NotALockedFact", fields: notLocked });
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('northstar.locked_edit', 'user', true)`);
    // The field names were checked against LOCKED_FIELDS above; the per-table types tell Drizzle
    // which columns those are.
    const updated =
      input.table === "role"
        ? await tx
            .update(role)
            .set(input.changes as Partial<typeof role.$inferInsert>)
            .where(and(eq(role.id, input.id), eq(role.candidateId, input.candidateId)))
            .returning({ id: role.id })
        : await tx
            .update(education)
            .set(input.changes as Partial<typeof education.$inferInsert>)
            .where(and(eq(education.id, input.id), eq(education.candidateId, input.candidateId)))
            .returning({ id: education.id });
    if (updated.length === 0) return err({ kind: "NotFound", id: input.id });
    await tx.insert(domainEvent).values({
      id: randomUUID(),
      candidateId: input.candidateId,
      aggregate: `candidate:${input.candidateId}`,
      type: "profile.locked_fact_edited",
      actor: "user",
      reason: input.reason,
      inputsSummary: "",
      // Field names only: the values are Paul's employment facts, which stay in their tables.
      payload: { table: input.table, fields },
      links: [],
      traceId: null,
      idempotencyKey: input.idempotencyKey,
      occurredAt: new Date(),
    });
    return ok({ fields });
  });
}

// The text hash of the current resume source, or null. The importer checks it before calling
// the model, so an unchanged resume costs no tokens.
export async function currentResumeHash(db: Db, candidateId: CandidateId): Promise<string | null> {
  const [row] = await db
    .select({ hash: profileSource.textSha256 })
    .from(profileSource)
    .where(
      and(
        eq(profileSource.candidateId, candidateId),
        eq(profileSource.kind, "resume"),
        isNull(profileSource.supersededAt),
      ),
    );
  return row?.hash ?? null;
}

export type ProfileView = {
  roles: {
    employer: string;
    title: string;
    startMonth: string | null;
    endMonth: string | null;
    current: boolean;
    atoms: string[];
  }[];
  unassignedAtoms: string[];
  skills: string[];
};

// The current resume source's roles with their atoms ("what" only), for `profile show`.
export async function readProfile(db: Db, candidateId: CandidateId): Promise<ProfileView | null> {
  const [source] = await db
    .select({ id: profileSource.id })
    .from(profileSource)
    .where(
      and(
        eq(profileSource.candidateId, candidateId),
        eq(profileSource.kind, "resume"),
        isNull(profileSource.supersededAt),
      ),
    );
  if (!source) return null;
  const roles = await db
    .select()
    .from(role)
    .where(eq(role.sourceId, source.id))
    .orderBy(role.position);
  const atoms = await db
    .select({ roleId: experienceAtom.roleId, what: experienceAtom.what })
    .from(experienceAtom)
    .where(eq(experienceAtom.sourceId, source.id))
    .orderBy(experienceAtom.position);
  const skills = await db
    .select({ name: skill.name })
    .from(skill)
    .where(eq(skill.sourceId, source.id));
  return {
    roles: roles.map((r) => ({
      employer: r.employer,
      title: r.title,
      startMonth: r.startMonth,
      endMonth: r.endMonth,
      current: r.isCurrent,
      atoms: atoms.filter((a) => a.roleId === r.id).map((a) => a.what),
    })),
    unassignedAtoms: atoms.filter((a) => a.roleId === null).map((a) => a.what),
    skills: skills.map((s) => s.name),
  };
}

// What the positioning thesis needs (NS-152, DX-009): the current resume import's roles with
// their locked dates, each atom's id and verbatim resume line, and the skills. Null before any
// import. Read-only; shown back to Paul only, never put in events or spans.
export type ThesisProfile = {
  roles: {
    employer: string;
    title: string;
    startMonth: string | null;
    endMonth: string | null;
    current: boolean;
  }[];
  atoms: { id: string; roleId: string | null; quote: string }[];
  skills: string[];
};

export async function readThesisProfile(
  db: Db,
  candidateId: CandidateId,
): Promise<ThesisProfile | null> {
  const [source] = await db
    .select({ id: profileSource.id })
    .from(profileSource)
    .where(
      and(
        eq(profileSource.candidateId, candidateId),
        eq(profileSource.kind, "resume"),
        isNull(profileSource.supersededAt),
      ),
    );
  if (!source) return null;
  const roles = await db
    .select()
    .from(role)
    .where(eq(role.sourceId, source.id))
    .orderBy(role.position);
  const atoms = await db
    .select({
      id: experienceAtom.id,
      roleId: experienceAtom.roleId,
      quote: experienceAtom.sourceQuote,
    })
    .from(experienceAtom)
    .where(eq(experienceAtom.sourceId, source.id))
    .orderBy(experienceAtom.position);
  const skills = await db
    .select({ name: skill.name })
    .from(skill)
    .where(eq(skill.sourceId, source.id));
  return {
    roles: roles.map((r) => ({
      employer: r.employer,
      title: r.title,
      startMonth: r.startMonth,
      endMonth: r.endMonth,
      current: r.isCurrent,
    })),
    atoms,
    skills: skills.map((s) => s.name),
  };
}
