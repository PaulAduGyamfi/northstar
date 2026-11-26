import { randomUUID } from "node:crypto";
import { ApplicationId, CandidateId, UNDO_WINDOW_MS } from "@northstar/domain";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decideApprovals,
  requestApproval,
  undoDecision,
  verifyApproval,
  withdrawApproval,
} from "./approval-write.js";
import type { Db } from "./db.js";
import {
  createTestDb,
  type Seeded,
  seedApplication,
  setGateClock,
  sqlState,
} from "./test/pglite.js";
import { transitionApplication } from "./transition-application.js";

// The app's database role (NS-212, migration 0065): it owns nothing; on append-only tables it may
// read, insert and lock rows only. Every committed migration is applied, so a table added later
// without `SELECT northstar_grant_app_role();` fails the first test.

const INSUFFICIENT_PRIVILEGE = "42501";
const NOW = new Date("2026-11-26T12:00:00Z");
const HASH = "a".repeat(64);

let db: Db;
let close: () => Promise<void>;
let seeded: Seeded;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  seeded = await seedApplication(db, "submitting");
  await setGateClock(db, NOW);
});

afterEach(async () => {
  await close();
});

type Row = Record<string, unknown>;
const rows = async (query: ReturnType<typeof sql>): Promise<Row[]> =>
  ((await db.execute(query)) as unknown as { rows: Row[] }).rows;

// Every table in public: whether a *_reject_change trigger guards its updates or deletes, whether
// it refuses updates, its first column, and the table and column privileges northstar_app holds.
async function tablesAndGrants(): Promise<
  {
    name: string;
    appendOnly: boolean;
    updateRefused: boolean;
    firstColumn: string;
    privileges: string[];
    columnUpdates: string[];
  }[]
> {
  const tables = await rows(sql`
    select c.relname as name,
      exists (
        select 1 from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid
        where tg.tgrelid = c.oid and not tg.tgisinternal
          and (tg.tgtype & 24) <> 0 and p.proname like '%\\_reject\\_change'
      ) as append_only,
      exists (
        select 1 from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid
        where tg.tgrelid = c.oid and not tg.tgisinternal
          and (tg.tgtype & 16) <> 0 and p.proname like '%\\_reject\\_change'
      ) as update_refused,
      (select a.attname from pg_attribute a
        where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        order by a.attnum limit 1) as first_column
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
    order by c.relname`);
  const grants = await rows(sql`
    select table_name, privilege_type from information_schema.role_table_grants
    where grantee = 'northstar_app' and table_schema = 'public'`);
  // Column grants a table-level grant doesn't already cover.
  const columns = await rows(sql`
    select cp.table_name, cp.column_name from information_schema.column_privileges cp
    where cp.grantee = 'northstar_app' and cp.table_schema = 'public'
      and cp.privilege_type = 'UPDATE'
      and not exists (
        select 1 from information_schema.role_table_grants g
        where g.grantee = 'northstar_app' and g.table_schema = 'public'
          and g.table_name = cp.table_name and g.privilege_type = 'UPDATE'
      )`);
  return tables.map((t) => ({
    name: String(t.name),
    appendOnly: t.append_only === true,
    updateRefused: t.update_refused === true,
    firstColumn: String(t.first_column),
    privileges: grants
      .filter((g) => g.table_name === t.name)
      .map((g) => String(g.privilege_type))
      .sort(),
    columnUpdates: columns.filter((c) => c.table_name === t.name).map((c) => String(c.column_name)),
  }));
}

describe("northstar_app's grants", () => {
  it("gives every table exactly what its kind allows", async () => {
    const wrong = (await tablesAndGrants()).filter((t) => {
      const expected = t.appendOnly
        ? {
            privileges: ["INSERT", "SELECT"],
            columnUpdates: t.updateRefused ? [t.firstColumn] : [],
          }
        : { privileges: ["DELETE", "INSERT", "SELECT", "UPDATE"], columnUpdates: [] };
      return (
        JSON.stringify([t.privileges, t.columnUpdates]) !==
        JSON.stringify([expected.privileges, expected.columnUpdates])
      );
    });
    expect(wrong).toEqual([]);
  });

  it("treats the event log, the Gate and the answer bank as append-only, and applications as not", async () => {
    const byName = new Map((await tablesAndGrants()).map((t) => [t.name, t.appendOnly]));
    expect(
      ["domain_event", "approval_decision", "approval_request", "bank_answer", "application"].map(
        (name) => byName.get(name),
      ),
    ).toEqual([true, true, true, true, false]);
  });

  it("owns no table, can't log in, belongs to no role and has no other power", async () => {
    const [owned] = await rows(sql`
      select count(*)::int as n from pg_class c join pg_roles r on r.oid = c.relowner
      where r.rolname = 'northstar_app'`);
    const [role] = await rows(sql`
      select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
      from pg_roles where rolname = 'northstar_app'`);
    const [memberOf] = await rows(sql`
      select count(*)::int as n from pg_auth_members m join pg_roles r on r.oid = m.member
      where r.rolname = 'northstar_app'`);
    expect([owned?.n, role, memberOf?.n]).toEqual([
      0,
      {
        rolcanlogin: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
      },
      0,
    ]);
  });
});

describe("acting as northstar_app", () => {
  let candidateId: CandidateId;

  beforeEach(async () => {
    candidateId = CandidateId.parse(seeded.candidateId);
    await db.execute(sql`set role northstar_app`);
  });

  const request = async () => {
    const r = await requestApproval(db, {
      candidateId,
      kind: "email_reply",
      subject: `email:${randomUUID()}`,
      contentSha256: HASH,
      facts: null,
      actor: "agent:inbox",
      idempotencyKey: randomUUID(),
    });
    if (!r.ok) throw new Error(r.error.kind);
    return r.value;
  };

  const approve = async (requestId: string): Promise<string> => {
    const d = await decideApprovals(db, {
      candidateId,
      requestIds: [requestId],
      decision: "approve",
    });
    const outcome = d.ok ? d.value[0]?.result : undefined;
    if (!outcome?.ok) throw new Error("not approved");
    return outcome.value.decisionId;
  };

  it("moves an application and writes its event", async () => {
    const result = await transitionApplication(db, {
      candidateId,
      applicationId: ApplicationId.parse(seeded.applicationId),
      from: "submitting",
      to: "submitted",
      actor: "agent:apply",
      reason: "The ATS accepted the form",
      inputsSummary: "",
      links: [],
      idempotencyKey: `application:${seeded.applicationId}:submit`,
      submittedVia: "approved",
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it("runs the Gate: request, approve, verify after the undo window, then withdraw", async () => {
    const { requestId } = await request();
    const decisionId = await approve(requestId);
    await setGateClock(db, new Date(NOW.getTime() + UNDO_WINDOW_MS));
    const [subjectRow] = await rows(
      sql`select subject from approval_request where id = ${requestId}`,
    );
    const subject = String(subjectRow?.subject);
    const verified = await verifyApproval(db, {
      candidateId,
      decisionId,
      kind: "email_reply",
      subject,
      contentSha256: HASH,
    });
    const withdrawn = await withdrawApproval(db, { candidateId, requestId, by: "user" });
    expect([verified.ok, withdrawn.ok]).toEqual([true, true]);
  });

  it("undoes a decision inside its window", async () => {
    const { requestId } = await request();
    const decisionId = await approve(requestId);
    expect(await undoDecision(db, { candidateId, decisionId })).toEqual({
      ok: true,
      value: { requestId },
    });
  });

  it("can lock rows of every table, as the write paths do", async () => {
    const tables = await tablesAndGrants();
    const refused: string[] = [];
    for (const t of tables) {
      const state = await sqlState(
        db.execute(sql`select 1 from ${sql.identifier(t.name)} limit 1 for update`),
      );
      if (state !== null) refused.push(`${t.name}: ${state}`);
    }
    expect(refused).toEqual([]);
  });

  it("can't update, delete or truncate the event log", async () => {
    expect([
      await sqlState(db.execute(sql`update domain_event set reason = 'rewritten'`)),
      await sqlState(db.execute(sql`delete from domain_event`)),
      await sqlState(db.execute(sql`truncate domain_event`)),
    ]).toEqual([INSUFFICIENT_PRIVILEGE, INSUFFICIENT_PRIVILEGE, INSUFFICIENT_PRIVILEGE]);
  });

  it("can't switch off an append-only trigger", async () => {
    expect(await sqlState(db.execute(sql`alter table domain_event disable trigger all`))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it("can't make a temporary table that would shadow a guard's lookup", async () => {
    expect(await sqlState(db.execute(sql`create temporary table approval_request (id uuid)`))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it("can't re-run the grants", async () => {
    expect(await sqlState(db.execute(sql`select northstar_grant_app_role()`))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });
});
