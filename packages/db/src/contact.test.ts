import { CandidateId, type ContactDetails } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { profileContact } from "./contact-schema.js";
import { readContact, setContact } from "./contact-write.js";
import type { Db } from "./db.js";
import { domainEvent } from "./schema.js";
import { createTestDb, seedApplication, sqlState } from "./test/pglite.js";

// Paul's contact details (NS-227 slice 3). Synthetic people and example.com only.

const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  candidateId = CandidateId.parse((await seedApplication(db, "discovered")).candidateId);
});

afterEach(async () => {
  await close();
});

const CONTACT: ContactDetails = {
  firstName: "Test",
  lastName: "Person",
  email: "test.person@example.com",
  phone: "+1 555 0100",
};
const set = (contact: ContactDetails, who = candidateId) =>
  setContact(db, { candidateId: who, contact });

describe("setContact and readContact", () => {
  it("reads nothing before Paul sets his contact details", async () => {
    expect(await readContact(db, candidateId)).toBeNull();
  });

  it("stores the details once, however often the same ones are saved", async () => {
    const first = await set(CONTACT);
    const again = await set({ ...CONTACT });
    expect([
      first,
      again,
      await readContact(db, candidateId),
      (await db.select({ id: profileContact.id }).from(profileContact)).length,
    ]).toEqual([
      { ok: true, value: { saved: true } },
      { ok: true, value: { saved: false } },
      CONTACT,
      1,
    ]);
  });

  it("makes the newest details current, a removed phone included", async () => {
    await set(CONTACT);
    await set({ ...CONTACT, phone: null });
    expect(await readContact(db, candidateId)).toEqual({ ...CONTACT, phone: null });
  });

  it("trims the details as the package's schema does", async () => {
    await set({ ...CONTACT, firstName: "  Test  " });
    expect((await readContact(db, candidateId))?.firstName).toBe("Test");
  });

  it("keeps each candidate's details to that candidate", async () => {
    await set(CONTACT);
    const other = CandidateId.parse((await seedApplication(db, "discovered")).candidateId);
    expect(await readContact(db, other)).toBeNull();
  });

  it("refuses bad details by field name, storing nothing", async () => {
    const results = [
      await set({ ...CONTACT, firstName: " " }),
      await set({ ...CONTACT, email: "not-an-email" }),
      await set({ ...CONTACT, email: `${"a".repeat(250)}@example.com` }),
      await set({ ...CONTACT, lastName: "Per\u0007son", phone: "x".repeat(41) }),
    ];
    expect([results, await readContact(db, candidateId)]).toEqual([
      [
        { ok: false, error: { kind: "InvalidContact", fields: ["firstName"] } },
        { ok: false, error: { kind: "InvalidContact", fields: ["email"] } },
        { ok: false, error: { kind: "InvalidContact", fields: ["email"] } },
        { ok: false, error: { kind: "InvalidContact", fields: ["lastName", "phone"] } },
      ],
      null,
    ]);
  });

  it("refuses line separators and invisible format characters by field name", async () => {
    const results = [
      await set({ ...CONTACT, firstName: "Te\u2028st" }),
      await set({ ...CONTACT, lastName: "Per\u202eson" }),
      await set({ ...CONTACT, phone: "555\u200b0100" }),
    ];
    expect([
      results.map((r) => (r.ok ? null : r.error.fields)),
      await readContact(db, candidateId),
    ]).toEqual([[["firstName"], ["lastName"], ["phone"]], null]);
  });

  it("ignores a key that isn't a contact field instead of refusing with no field", async () => {
    const extra = { ...CONTACT, middleName: "X" } as ContactDetails;
    expect([await set(extra), await readContact(db, candidateId)]).toEqual([
      { ok: true, value: { saved: true } },
      CONTACT,
    ]);
  });

  it("writes an event with fixed words and a phone flag, never the details", async () => {
    await set(CONTACT);
    const [event] = await db
      .select({ payload: domainEvent.payload, reason: domainEvent.reason })
      .from(domainEvent)
      .where(eq(domainEvent.type, "profile.contact_set"));
    const text = JSON.stringify(event);
    expect([
      (event?.payload as Record<string, unknown> | undefined)?.phone,
      event?.reason,
      ["Test", "Person", "example.com", "555"].some((s) => text.includes(s)),
    ]).toEqual([true, "You updated your contact details", false]);
  });

  it("is guarded by the database too: bad shapes are refused", async () => {
    const row = (over: Partial<typeof profileContact.$inferInsert>) =>
      db.insert(profileContact).values({ candidateId, ...CONTACT, ...over });
    expect([
      await sqlState(row({ firstName: "" })),
      await sqlState(row({ email: "nobody" })),
      await sqlState(row({ phone: "" })),
      await sqlState(row({ lastName: "Per\nson" })),
    ]).toEqual([CHECK_VIOLATION, CHECK_VIOLATION, CHECK_VIOLATION, CHECK_VIOLATION]);
  });

  it("refuses changing, deleting or truncating stored details", async () => {
    await set(CONTACT);
    expect([
      await sqlState(db.update(profileContact).set({ firstName: "Other" })),
      await sqlState(db.delete(profileContact)),
      await sqlState(db.execute(sql`truncate profile_contact`)),
    ]).toEqual([RESTRICT_VIOLATION, RESTRICT_VIOLATION, RESTRICT_VIOLATION]);
  });
});
