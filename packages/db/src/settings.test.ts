import { CandidateId } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { profileSetting } from "./profile-schema.js";
import { candidate, domainEvent } from "./schema.js";
import { readProfileSettings, recordFactualAnswer, setProfileSetting } from "./settings-write.js";
import { createTestDb, sqlState } from "./test/pglite.js";

// Profile settings (NS-141, ANS-001). Synthetic values only.

const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;

async function newCandidate(): Promise<CandidateId> {
  const [c] = await db.insert(candidate).values({ displayName: "Test Candidate" }).returning();
  if (!c) throw new Error("no candidate");
  return CandidateId.parse(c.id);
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  candidateId = await newCandidate();
});

afterEach(async () => {
  await close();
});

const set = (field: string, value: string, qualifier?: string, owner = candidateId) =>
  setProfileSetting(db, { candidateId: owner, field, value, qualifier });

describe("setProfileSetting", () => {
  it("makes the newest value of a field the current one", async () => {
    await set("notice_period", "2 weeks");
    await set("notice_period", "1 month");
    expect(await readProfileSettings(db, candidateId)).toEqual([
      { field: "notice_period", qualifier: "", value: "1 month" },
    ]);
  });

  it("stores nothing when the field already has that value", async () => {
    const first = await set("notice_period", "2 weeks");
    const again = await set("notice_period", "2 weeks");
    const rows = await db.select().from(profileSetting);
    expect([first, again, rows.length]).toEqual([
      { ok: true, value: { saved: true } },
      { ok: true, value: { saved: false } },
      1,
    ]);
  });

  it("keeps one value per qualifier, matching qualifiers case-insensitively", async () => {
    await set("years_of_experience", "5", "Go");
    await set("years_of_experience", "3", "Rust");
    await set("years_of_experience", "6", "go");
    expect(await readProfileSettings(db, candidateId)).toEqual([
      { field: "years_of_experience", qualifier: "go", value: "6" },
      { field: "years_of_experience", qualifier: "Rust", value: "3" },
    ]);
  });

  it("refuses an unknown field, a missing or extra qualifier and an empty value", async () => {
    const results = await Promise.all([
      set("favorite_color", "blue"),
      set("years_of_experience", "5"),
      set("notice_period", "2 weeks", "Go"),
      set("notice_period", "   "),
    ]);
    expect(results.map((r) => (r.ok ? "ok" : r.error.reason))).toEqual([
      "unknown_field",
      "qualifier_required",
      "qualifier_not_allowed",
      "bad_length",
    ]);
  });

  it("keeps each candidate's settings to that candidate", async () => {
    const other = await newCandidate();
    await set("notice_period", "2 weeks", undefined, other);
    expect(await readProfileSettings(db, candidateId)).toEqual([]);
  });

  it("writes an event with the field and no value or qualifier", async () => {
    await set("work_authorization", "yes", "Canada");
    const [event] = await db
      .select({ type: domainEvent.type, payload: domainEvent.payload, reason: domainEvent.reason })
      .from(domainEvent);
    const text = JSON.stringify(event);
    expect([event?.type, text.includes("Canada"), text.includes('"yes"')]).toEqual([
      "profile.setting_set",
      false,
      false,
    ]);
  });
});

describe("profile_setting in the database", () => {
  it("refuses a keyed field with no qualifier", async () => {
    expect(
      await sqlState(
        db
          .insert(profileSetting)
          .values({ candidateId, field: "work_authorization", value: "yes" }),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it("refuses UPDATE, DELETE and TRUNCATE", async () => {
    await set("notice_period", "2 weeks");
    expect([
      await sqlState(
        db
          .update(profileSetting)
          .set({ value: "x" })
          .where(eq(profileSetting.candidateId, candidateId)),
      ),
      await sqlState(db.delete(profileSetting).where(eq(profileSetting.candidateId, candidateId))),
      await sqlState(db.execute(sql`truncate profile_setting`)),
    ]).toEqual([RESTRICT_VIOLATION, RESTRICT_VIOLATION, RESTRICT_VIOLATION]);
  });
});

describe("recordFactualAnswer", () => {
  it("writes the canonical id, kind, field and confidence only", async () => {
    await recordFactualAnswer(db, {
      candidateId,
      canonicalId: "years-experience",
      kind: "factual",
      field: "years_of_experience",
      confidence: 0.876,
    });
    const [event] = await db
      .select({ type: domainEvent.type, payload: domainEvent.payload })
      .from(domainEvent);
    expect(event).toEqual({
      type: "answer.factual_used",
      payload: {
        canonicalId: "years-experience",
        kind: "factual",
        field: "years_of_experience",
        confidence: 0.88,
      },
    });
  });
});
