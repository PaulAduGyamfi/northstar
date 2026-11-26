import { ApplicationId, CandidateId } from "@northstar/domain";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { createTestDb, type Seeded, seedApplication, sqlState } from "./test/pglite.js";
import { transitionApplication } from "./transition-application.js";

// The app's database role (NS-212, migration 0065): it owns nothing and may only read and insert
// on append-only tables. Every committed migration is applied, so a table added later without
// `SELECT northstar_grant_app_role();` fails the first test.

const INSUFFICIENT_PRIVILEGE = "42501";

let db: Db;
let close: () => Promise<void>;
let seeded: Seeded;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  seeded = await seedApplication(db, "submitting");
});

afterEach(async () => {
  await close();
});

type Row = Record<string, unknown>;
const rows = async (query: ReturnType<typeof sql>): Promise<Row[]> =>
  ((await db.execute(query)) as unknown as { rows: Row[] }).rows;

// Every table in public, whether a *_reject_change trigger guards its updates or deletes, and the
// privileges northstar_app holds on it.
async function grantsByTable(): Promise<
  Map<string, { appendOnly: boolean; privileges: string[] }>
> {
  const tables = await rows(sql`
    select c.relname as name,
      exists (
        select 1 from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid
        where tg.tgrelid = c.oid and not tg.tgisinternal
          and (tg.tgtype & 24) <> 0 and p.proname like '%\_reject\_change'
      ) as append_only
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
    order by c.relname`);
  const grants = await rows(sql`
    select table_name, privilege_type from information_schema.role_table_grants
    where grantee = 'northstar_app' and table_schema = 'public'`);
  return new Map(
    tables.map((t) => [
      String(t.name),
      {
        appendOnly: t.append_only === true,
        privileges: grants
          .filter((g) => g.table_name === t.name)
          .map((g) => String(g.privilege_type))
          .sort(),
      },
    ]),
  );
}

describe("northstar_app's grants", () => {
  it("gives every table exactly what its kind allows", async () => {
    const wrong = [...(await grantsByTable())].filter(([, t]) => {
      const expected = t.appendOnly
        ? ["INSERT", "SELECT"]
        : ["DELETE", "INSERT", "SELECT", "UPDATE"];
      return JSON.stringify(t.privileges) !== JSON.stringify(expected);
    });
    expect(wrong).toEqual([]);
  });

  it("treats the event log, the Gate and the answer bank as append-only, and applications as not", async () => {
    const byTable = await grantsByTable();
    expect(
      ["domain_event", "approval_decision", "approval_request", "bank_answer", "application"].map(
        (name) => byTable.get(name)?.appendOnly,
      ),
    ).toEqual([true, true, true, true, false]);
  });

  it("owns no table and can't log in", async () => {
    const [owned] = await rows(sql`
      select count(*)::int as n from pg_class c join pg_roles r on r.oid = c.relowner
      where r.rolname = 'northstar_app'`);
    const [role] = await rows(
      sql`select rolcanlogin from pg_roles where rolname = 'northstar_app'`,
    );
    expect([owned?.n, role?.rolcanlogin]).toEqual([0, false]);
  });
});

describe("acting as northstar_app", () => {
  beforeEach(async () => {
    await db.execute(sql`set role northstar_app`);
  });

  it("moves an application and writes its event", async () => {
    const result = await transitionApplication(db, {
      candidateId: CandidateId.parse(seeded.candidateId),
      applicationId: ApplicationId.parse(seeded.applicationId),
      from: "submitting",
      to: "submitted",
      actor: "agent:apply",
      reason: "The ATS accepted the form",
      inputsSummary: "",
      links: [],
      idempotencyKey: `application:${seeded.applicationId}:submit`,
      submittedVia: "approved",
      now: new Date("2026-11-26T12:00:00Z"),
    });
    expect(result.ok).toBe(true);
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

  it("can't re-run the grants", async () => {
    expect(await sqlState(db.execute(sql`select northstar_grant_app_role()`))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });
});
