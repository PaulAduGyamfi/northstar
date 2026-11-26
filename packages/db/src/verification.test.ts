import { randomUUID } from "node:crypto";
import { CandidateId, feedLine } from "@northstar/domain";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { candidate, domainEvent } from "./schema.js";
import { createTestDb, sqlState } from "./test/pglite.js";
import {
  verificationUsedMessage,
  verificationWindow,
  verificationWindowClose,
  verificationWindowRestart,
} from "./verification-schema.js";
import { dbWindowStore, type StoredWindowRow } from "./verification-write.js";

// Verification windows on PGlite (NS-151). Synthetic tenant, domains and Gmail ids only.

const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";
const T0 = new Date("2026-11-26T12:00:00Z");
const TTL = 600_000;

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

function window(over: Partial<StoredWindowRow["window"]> = {}): StoredWindowRow["window"] {
  return {
    id: randomUUID(),
    tenant: "Acme",
    ats: "Workday",
    purpose: "sign_up",
    senderDomains: ["myworkday.com"],
    linkHosts: ["acme.wd5.myworkdayjobs.com"],
    openedAt: T0,
    expiresAt: new Date(T0.getTime() + TTL),
    ...over,
  };
}

const at = (ms: number) => new Date(T0.getTime() + ms);

async function events() {
  return db
    .select({
      type: domainEvent.type,
      payload: domainEvent.payload,
      reason: domainEvent.reason,
      actor: domainEvent.actor,
    })
    .from(domainEvent)
    .where(eq(domainEvent.candidateId, candidateId))
    .orderBy(domainEvent.position);
}

describe("dbWindowStore", () => {
  it("reads back an open window with its domains, hosts and times", async () => {
    const store = dbWindowStore(db, candidateId);
    const w = window();
    await store.insert(w, TTL);
    expect(await store.openWindows()).toEqual([{ window: w, ttlMs: TTL, resent: false }]);
  });

  it("gives a message to one window only", async () => {
    const store = dbWindowStore(db, candidateId);
    const a = window();
    const b = window();
    await store.insert(a, TTL);
    await store.insert(b, TTL);
    expect(await store.isUsed("msg-1")).toBe(false);
    expect(await store.claim("msg-1", a.id, at(1_000))).toBe(true);
    expect(await store.claim("msg-1", b.id, at(1_000))).toBe(false);
    expect(await store.isUsed("msg-1")).toBe(true);
  });

  it("restarts a window once, and reads its new times", async () => {
    const store = dbWindowStore(db, candidateId);
    const w = window();
    await store.insert(w, TTL);
    expect(await store.restart(w.id, at(TTL), at(2 * TTL))).toBe(true);
    expect(await store.restart(w.id, at(2 * TTL), at(3 * TTL))).toBe(false);
    expect(await store.read(w.id)).toEqual({
      window: { ...w, openedAt: at(TTL), expiresAt: at(2 * TTL) },
      ttlMs: TTL,
      resent: true,
      closed: false,
    });
  });

  it("closes a window once, after which it is no longer open", async () => {
    const store = dbWindowStore(db, candidateId);
    const w = window();
    await store.insert(w, TTL);
    expect(await store.close(w.id, "verified", at(5_000), false)).toBe(true);
    expect(await store.close(w.id, "no_email", at(6_000), false)).toBe(false);
    expect(await store.openWindows()).toEqual([]);
    expect((await store.read(w.id))?.closed).toBe(true);
    expect(await store.restart(w.id, at(TTL), at(2 * TTL))).toBe(false);
  });

  it("refuses a close from a caller that read the window before its resend", async () => {
    const store = dbWindowStore(db, candidateId);
    const w = window();
    await store.insert(w, TTL);
    await store.restart(w.id, at(TTL), at(2 * TTL));
    // The caller found a code in a mail it matched against the old window: that code is void.
    expect(await store.close(w.id, "verified", at(TTL + 1_000), false)).toBe(false);
    expect(await store.close(w.id, "verified", at(TTL + 1_000), true)).toBe(true);
  });

  it("writes one event for the resend and one for the close, with names and outcome only", async () => {
    const store = dbWindowStore(db, candidateId);
    const w = window();
    await store.insert(w, TTL);
    await store.restart(w.id, at(TTL), at(2 * TTL));
    await store.close(w.id, "no_email", at(2 * TTL), true);
    const payload = (outcome: string) => ({
      windowId: w.id,
      tenant: "Acme",
      ats: "Workday",
      purpose: "sign_up",
      outcome,
    });
    const rows = await events();
    expect(rows.map(({ type, payload, actor }) => ({ type, payload, actor }))).toEqual([
      { type: "verification.resend", payload: payload("resend"), actor: "system" },
      { type: "verification.needs_human", payload: payload("no_email"), actor: "system" },
    ]);
    expect(rows.map((e) => feedLine(e))).toEqual([
      "Sent the email code again for Acme (Workday)",
      "Couldn't verify email for Acme (Workday): needs your hands",
    ]);
  });

  it("shows a verified window in the feed by its tenant and ATS only", async () => {
    const store = dbWindowStore(db, candidateId);
    const w = window();
    await store.insert(w, TTL);
    await store.close(w.id, "verified", at(5_000), false);
    const [row] = await events();
    expect(row && feedLine(row)).toBe("Verified email for Acme (Workday)");
  });

  it("keeps each candidate's windows and messages apart", async () => {
    const [other] = await db.insert(candidate).values({ displayName: "Other" }).returning();
    if (!other) throw new Error("no candidate");
    const mine = dbWindowStore(db, candidateId);
    const theirs = dbWindowStore(db, CandidateId.parse(other.id));
    const w = window();
    await mine.insert(w, TTL);
    expect(await theirs.openWindows()).toEqual([]);
    expect(await theirs.read(w.id)).toBeNull();
    expect(await theirs.close(w.id, "verified", at(1_000), false)).toBe(false);
  });

  it("refuses an edit or delete of any verification row", async () => {
    const store = dbWindowStore(db, candidateId);
    const w = window();
    await store.insert(w, TTL);
    await store.claim("msg-1", w.id, at(1_000));
    await store.restart(w.id, at(TTL), at(2 * TTL));
    await store.close(w.id, "verified", at(TTL + 1), true);
    expect([
      await sqlState(db.update(verificationWindow).set({ tenant: "Globex" })),
      await sqlState(db.delete(verificationUsedMessage)),
      await sqlState(db.delete(verificationWindowRestart)),
      await sqlState(db.delete(verificationWindowClose)),
    ]).toEqual([RESTRICT_VIOLATION, RESTRICT_VIOLATION, RESTRICT_VIOLATION, RESTRICT_VIOLATION]);
  });

  it("refuses a wildcard sender, a markup tenant and a window over 30 minutes", async () => {
    const store = dbWindowStore(db, candidateId);
    expect([
      await sqlState(store.insert(window({ senderDomains: ["*.example.com"] }), TTL)),
      await sqlState(store.insert(window({ tenant: "<b>Acme</b>" }), TTL)),
      await sqlState(store.insert(window(), 31 * 60_000)),
      await sqlState(store.insert(window({ senderDomains: [] }), TTL)),
    ]).toEqual([CHECK_VIOLATION, CHECK_VIOLATION, CHECK_VIOLATION, CHECK_VIOLATION]);
    const rows = await db.select({ id: verificationWindow.id }).from(verificationWindow);
    expect(rows).toEqual([]);
  });
});
