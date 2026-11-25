import { CandidateId } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consentPolicy, consentRecord } from "./consent-schema.js";
import { readConsentPolicy, recordConsent, setConsentPolicy } from "./consent-write.js";
import type { Db } from "./db.js";
import { domainEvent } from "./schema.js";
import { employerTenant, tenantAccountStatus } from "./tenant-schema.js";
import { beginAccountCreation, listTenants, moveAccount, registerTenant } from "./tenant-write.js";
import { createTestDb, seedApplication, setGateClock, sqlState } from "./test/pglite.js";

// The tenant registry and consent records (NS-124) on PGlite. Synthetic tenants, example.com
// addresses and made-up notice text only.
const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";
const NOW = new Date("2026-11-25T12:00:00Z");
const TENANT = {
  tenantKey: "workday:globex",
  tenantUrl: "https://globex.wd1.myworkdayjobs.com/careers",
  accountEmail: "applicant+ns-abc123@example.com",
};
const NOTICE = {
  tenantKey: "workday:globex",
  kind: "privacy" as const,
  noticeUrl: "https://globex.example.com/privacy",
  text: "Globex Candidate Privacy Notice. We keep your application for two years.",
};

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  candidateId = CandidateId.parse((await seedApplication(db, "queued")).candidateId);
  await setGateClock(db, NOW);
});

afterEach(async () => {
  await close();
});

const register = () => registerTenant(db, { candidateId, ...TENANT });
const events = (type: string) => db.select().from(domainEvent).where(eq(domainEvent.type, type));

describe("registerTenant", () => {
  it("stores a tenant once with status none, and returns the same row the second time", async () => {
    const first = await register();
    const second = await register();
    expect([first.ok && first.value.created, second.ok && second.value.created]).toEqual([
      true,
      false,
    ]);
    expect(first.ok && second.ok && first.value.tenantId === second.value.tenantId).toBe(true);
    expect(await db.select().from(employerTenant)).toHaveLength(1);
    expect((await listTenants(db, candidateId)).map((t) => [t.tenantKey, t.ats, t.status])).toEqual(
      [["workday:globex", "workday", "none"]],
    );
  });

  it("refuses a tenant key, URL or email that breaks the rules, and stores nothing", async () => {
    const bad = [
      { ...TENANT, tenantKey: "Workday:Globex" },
      { ...TENANT, tenantUrl: "http://globex.example.com" },
      { ...TENANT, tenantUrl: "javascript:alert(1)" },
      { ...TENANT, accountEmail: "not an email" },
    ];
    const results = await Promise.all(bad.map((b) => registerTenant(db, { candidateId, ...b })));
    expect(results.map((r) => !r.ok && r.error.kind)).toEqual([
      "InvalidTenant",
      "InvalidTenant",
      "InvalidTenant",
      "InvalidTenant",
    ]);
    expect(await db.select().from(employerTenant)).toEqual([]);
  });

  it("the database refuses a non-https URL or an ATS that doesn't match the key", async () => {
    const row = { candidateId, ...TENANT, ats: "workday", createdAt: NOW };
    expect(
      await sqlState(
        db.insert(employerTenant).values({ ...row, tenantUrl: "http://x.example.com" }),
      ),
    ).toBe(CHECK_VIOLATION);
    expect(await sqlState(db.insert(employerTenant).values({ ...row, ats: "greenhouse" }))).toBe(
      CHECK_VIOLATION,
    );
  });

  it("writes a tenant.registered event with the key and ATS, never the email or URL", async () => {
    await register();
    const [e] = await events("tenant.registered");
    expect(e?.payload).toEqual({ tenantKey: "workday:globex", ats: "workday" });
    expect(JSON.stringify([e?.payload, e?.reason, e?.inputsSummary])).not.toMatch(
      /example\.com|myworkdayjobs/,
    );
  });
});

describe("beginAccountCreation (ACC-006)", () => {
  it("starts exactly one creation, even when called twice at once", async () => {
    await register();
    const [a, b] = await Promise.all([
      beginAccountCreation(db, { candidateId, tenantKey: TENANT.tenantKey, actor: "agent:apply" }),
      beginAccountCreation(db, { candidateId, tenantKey: TENANT.tenantKey, actor: "agent:apply" }),
    ]);
    const outcomes = [a, b].map((r) => (r.ok ? "started" : r.error.kind)).sort();
    expect(outcomes).toEqual(["AlreadyStarted", "started"]);
    expect(await db.select().from(tenantAccountStatus)).toHaveLength(1);
  });

  it("tells a later caller the account's current status instead of creating another", async () => {
    await register();
    await beginAccountCreation(db, {
      candidateId,
      tenantKey: TENANT.tenantKey,
      actor: "agent:apply",
    });
    await moveAccount(db, {
      candidateId,
      tenantKey: TENANT.tenantKey,
      from: "creating",
      to: "active",
      reason: "created",
      actor: "agent:apply",
    });
    const again = await beginAccountCreation(db, {
      candidateId,
      tenantKey: TENANT.tenantKey,
      actor: "agent:apply",
    });
    expect(again).toEqual({ ok: false, error: { kind: "AlreadyStarted", status: "active" } });
  });

  it("answers NotFound for a tenant that isn't registered", async () => {
    const r = await beginAccountCreation(db, {
      candidateId,
      tenantKey: "workday:initech",
      actor: "agent:apply",
    });
    expect(r).toEqual({ ok: false, error: { kind: "NotFound" } });
  });
});

describe("moveAccount", () => {
  it("records each move, and listTenants shows the newest status", async () => {
    await register();
    await beginAccountCreation(db, {
      candidateId,
      tenantKey: TENANT.tenantKey,
      actor: "agent:apply",
    });
    const r = await moveAccount(db, {
      candidateId,
      tenantKey: TENANT.tenantKey,
      from: "creating",
      to: "verifying",
      reason: "email_sent",
      actor: "agent:apply",
    });
    expect(r).toEqual({ ok: true, value: { status: "verifying" } });
    const [t] = await listTenants(db, candidateId);
    expect([t?.status, t?.changedAt?.toISOString()]).toEqual(["verifying", NOW.toISOString()]);
  });

  it("refuses a move from a status that is no longer current, and stores nothing", async () => {
    await register();
    const r = await moveAccount(db, {
      candidateId,
      tenantKey: TENANT.tenantKey,
      from: "creating",
      to: "active",
      reason: "created",
      actor: "agent:apply",
    });
    expect(r).toEqual({
      ok: false,
      error: { kind: "StaleStatus", expected: "creating", actual: "none" },
    });
    expect(await db.select().from(tenantAccountStatus)).toEqual([]);
  });

  it("refuses a move the state machine doesn't allow", async () => {
    await register();
    const r = await moveAccount(db, {
      candidateId,
      tenantKey: TENANT.tenantKey,
      from: "none",
      to: "active",
      reason: "created",
      actor: "user",
    });
    expect(r.ok || r.error.kind).toBe("IllegalAccountMove");
  });

  it("refuses a reason that isn't a lowercase code", async () => {
    await register();
    const r = await moveAccount(db, {
      candidateId,
      tenantKey: TENANT.tenantKey,
      from: "none",
      to: "creating",
      reason: "Paul said so at paul@example.com",
      actor: "user",
    });
    expect(r).toEqual({ ok: false, error: { kind: "InvalidReason" } });
  });

  it("writes an account_changed event with the key, statuses and reason only", async () => {
    await register();
    await beginAccountCreation(db, {
      candidateId,
      tenantKey: TENANT.tenantKey,
      actor: "agent:apply",
    });
    const [e] = await events("tenant.account_changed");
    expect(e?.payload).toEqual({
      tenantKey: "workday:globex",
      ats: "workday",
      from: "none",
      to: "creating",
      reason: "started",
    });
  });
});

describe("the consent policy (ACC-008)", () => {
  it("is auto until Paul sets it, then the newest setting", async () => {
    expect(await readConsentPolicy(db, candidateId)).toBe("auto");
    await setConsentPolicy(db, { candidateId, policy: "ask_per_tenant" });
    expect(await readConsentPolicy(db, candidateId)).toBe("ask_per_tenant");
    await setConsentPolicy(db, { candidateId, policy: "auto" });
    expect(await readConsentPolicy(db, candidateId)).toBe("auto");
  });
});

describe("recordConsent (ACC-008)", () => {
  it("keeps the notice's text, URL and hash, and an event with the hash only", async () => {
    await register();
    const r = await recordConsent(db, { candidateId, ...NOTICE });
    expect(r.ok).toBe(true);
    const [row] = await db.select().from(consentRecord);
    expect([row?.kind, row?.noticeUrl, row?.text, row?.textSha256.length]).toEqual([
      "privacy",
      NOTICE.noticeUrl,
      NOTICE.text,
      64,
    ]);
    const [e] = await events("consent.recorded");
    expect(e?.payload).toEqual({
      tenantKey: "workday:globex",
      kind: "privacy",
      textSha256: row?.textSha256,
    });
    expect(JSON.stringify([e?.payload, e?.reason])).not.toMatch(/Globex Candidate|example\.com/);
  });

  it("refuses to record an acceptance under ask_per_tenant, so nothing is accepted without Paul", async () => {
    await register();
    await setConsentPolicy(db, { candidateId, policy: "ask_per_tenant" });
    const r = await recordConsent(db, { candidateId, ...NOTICE });
    expect(r).toEqual({ ok: false, error: { kind: "AskPaul" } });
    expect(await db.select().from(consentRecord)).toEqual([]);
  });

  it("refuses a marketing opt-in, and stores nothing", async () => {
    await register();
    const r = await recordConsent(db, { candidateId, ...NOTICE, kind: "marketing" });
    expect(r).toEqual({ ok: false, error: { kind: "MarketingRefused" } });
    expect(await db.select().from(consentRecord)).toEqual([]);
  });

  it("refuses a notice for a tenant that isn't registered", async () => {
    const r = await recordConsent(db, { candidateId, ...NOTICE, tenantKey: "workday:initech" });
    expect(r).toEqual({ ok: false, error: { kind: "NotFound" } });
  });

  it("the database refuses a hash that doesn't match the stored text", async () => {
    const reg = await register();
    if (!reg.ok) throw new Error("not registered");
    expect(
      await sqlState(
        db.insert(consentRecord).values({
          candidateId,
          tenantId: reg.value.tenantId,
          kind: "terms",
          noticeUrl: NOTICE.noticeUrl,
          textSha256: "0".repeat(64),
          text: NOTICE.text,
          acceptedAt: NOW,
        }),
      ),
    ).toBe(CHECK_VIOLATION);
  });
});

describe("the registry and consent tables", () => {
  it("can't be updated, deleted or truncated", async () => {
    await register();
    await beginAccountCreation(db, {
      candidateId,
      tenantKey: TENANT.tenantKey,
      actor: "agent:apply",
    });
    await setConsentPolicy(db, { candidateId, policy: "auto" });
    await recordConsent(db, { candidateId, ...NOTICE });
    const states = [
      await sqlState(db.update(employerTenant).set({ accountEmail: "other@example.com" })),
      await sqlState(db.delete(employerTenant)),
      await sqlState(db.update(tenantAccountStatus).set({ toStatus: "active" })),
      await sqlState(db.delete(tenantAccountStatus)),
      await sqlState(db.update(consentPolicy).set({ policy: "ask_per_tenant" })),
      await sqlState(db.delete(consentRecord)),
      await sqlState(db.execute(sql`truncate consent_record`)),
      await sqlState(db.execute(sql`truncate tenant_account_status`)),
    ];
    expect(states).toEqual(Array(8).fill(RESTRICT_VIOLATION));
  });
});
