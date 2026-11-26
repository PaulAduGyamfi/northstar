import { randomUUID } from "node:crypto";
import { CandidateId } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import {
  type DeadLetterInput,
  listOpenDeadLetters,
  recordDeadLetter,
  resolveDeadLetter,
} from "./dead-letter-write.js";
import { deadLetter, deadLetterResolution } from "./resilience-schema.js";
import { candidate, domainEvent } from "./schema.js";
import { createTestDb, sqlState } from "./test/pglite.js";

// The dead-letter store (NS-175, RES-007). Synthetic kinds, subjects and codes only.

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

const letter = (over: Partial<DeadLetterInput> = {}): DeadLetterInput => ({
  candidateId,
  kind: "apply.submit",
  subject: `application:${randomUUID()}`,
  reasonCode: "timeout",
  attempts: 3,
  idempotencyKey: randomUUID(),
  ...over,
});

async function record(over: Partial<DeadLetterInput> = {}): Promise<string> {
  const r = await recordDeadLetter(db, letter(over));
  if (!r.ok) throw new Error(r.error.field);
  return r.value.deadLetterId;
}

describe("recordDeadLetter", () => {
  it("stores one letter for the same key, and another for a new key", async () => {
    const input = letter();
    const first = await recordDeadLetter(db, input);
    const again = await recordDeadLetter(db, input);
    await recordDeadLetter(db, letter());
    expect([first.ok && first.value.status, again.ok && again.value]).toEqual([
      "recorded",
      { status: "exists", deadLetterId: first.ok ? first.value.deadLetterId : "" },
    ]);
    expect(await db.select().from(deadLetter)).toHaveLength(2);
  });

  it("writes one event with ids, kind, codes and counts only", async () => {
    const id = await record({ attempts: 1 });
    const [event] = await db
      .select()
      .from(domainEvent)
      .where(eq(domainEvent.type, "dead_letter.recorded"));
    expect([event?.reason, event?.payload]).toEqual([
      "Work stopped after 1 attempt; it waits for you to retry, skip or hand it off",
      { deadLetterId: id, kind: "apply.submit", reasonCode: "timeout", attempts: 1 },
    ]);
  });

  it("refuses a malformed kind, subject, reason code or attempt count", async () => {
    const results = await Promise.all([
      recordDeadLetter(db, letter({ kind: "Apply Submit" })),
      recordDeadLetter(db, letter({ subject: "https://example.com/job" })),
      recordDeadLetter(db, letter({ reasonCode: "Timed out after 30s" })),
      recordDeadLetter(db, letter({ attempts: 0 })),
      recordDeadLetter(db, letter({ idempotencyKey: "" })),
    ]);
    expect(results.map((r) => (r.ok ? null : r.error.field))).toEqual([
      "kind",
      "subject",
      "reasonCode",
      "attempts",
      "idempotencyKey",
    ]);
    expect(await db.select().from(deadLetter)).toEqual([]);
  });
});

describe("listOpenDeadLetters", () => {
  it("lists letters with no resolution, oldest first, optionally by kind", async () => {
    const a = await record();
    const b = await record({ kind: "llm.route:story-draft" });
    const c = await record();
    await resolveDeadLetter(db, { candidateId, deadLetterId: c, action: "skip", actor: "user" });
    const ids = (await listOpenDeadLetters(db, candidateId)).map((l) => l.deadLetterId);
    const byKind = (await listOpenDeadLetters(db, candidateId, "llm.route:story-draft")).map(
      (l) => l.deadLetterId,
    );
    expect([ids, byKind]).toEqual([[a, b], [b]]);
  });

  it("never lists another candidate's letters", async () => {
    await record();
    expect(await listOpenDeadLetters(db, await newCandidate())).toEqual([]);
  });
});

describe("resolveDeadLetter", () => {
  it.each(["retry", "skip", "hand_off"] as const)(
    "resolves a letter once with %s and returns its kind and subject",
    async (action) => {
      const subject = `application:${randomUUID()}`;
      const id = await record({ subject });
      const first = await resolveDeadLetter(db, {
        candidateId,
        deadLetterId: id,
        action,
        actor: "user",
      });
      const second = await resolveDeadLetter(db, {
        candidateId,
        deadLetterId: id,
        action: "skip",
        actor: "user",
      });
      expect([first, second]).toEqual([
        { ok: true, value: { kind: "apply.submit", subject } },
        { ok: false, error: { kind: "AlreadyResolved" } },
      ]);
    },
  );

  it("says what was chosen in its event", async () => {
    const id = await record();
    await resolveDeadLetter(db, {
      candidateId,
      deadLetterId: id,
      action: "hand_off",
      actor: "user",
    });
    const [event] = await db
      .select()
      .from(domainEvent)
      .where(eq(domainEvent.type, "dead_letter.resolved"));
    expect([
      event?.actor,
      event?.reason,
      (event?.payload as { action?: string } | undefined)?.action,
    ]).toEqual(["user", "Handed off to do by hand", "hand_off"]);
  });

  it("is NotFound for another candidate's letter or a malformed id", async () => {
    const id = await record();
    const other = await newCandidate();
    expect([
      await resolveDeadLetter(db, {
        candidateId: other,
        deadLetterId: id,
        action: "skip",
        actor: "user",
      }),
      await resolveDeadLetter(db, {
        candidateId,
        deadLetterId: "nope",
        action: "skip",
        actor: "user",
      }),
    ]).toEqual([
      { ok: false, error: { kind: "NotFound" } },
      { ok: false, error: { kind: "NotFound" } },
    ]);
  });
});

describe("dead-letter tables in the database", () => {
  it("refuses update, delete and truncate on both tables", async () => {
    const id = await record();
    await resolveDeadLetter(db, {
      candidateId,
      deadLetterId: id,
      action: "retry",
      actor: "system",
    });
    expect([
      await sqlState(db.update(deadLetter).set({ attempts: 9 }).where(eq(deadLetter.id, id))),
      await sqlState(db.delete(deadLetter).where(eq(deadLetter.id, id))),
      await sqlState(db.execute(sql`truncate dead_letter cascade`)),
      await sqlState(
        db
          .update(deadLetterResolution)
          .set({ action: "skip" })
          .where(eq(deadLetterResolution.deadLetterId, id)),
      ),
      await sqlState(
        db.delete(deadLetterResolution).where(eq(deadLetterResolution.deadLetterId, id)),
      ),
      await sqlState(db.execute(sql`truncate dead_letter_resolution`)),
    ]).toEqual(Array(6).fill(RESTRICT_VIOLATION));
  });

  it("refuses free text in a reason code even written directly", async () => {
    expect(
      await sqlState(
        db.insert(deadLetter).values({
          candidateId,
          kind: "apply.submit",
          subject: `application:${randomUUID()}`,
          reasonCode: "The ATS said: invalid email jane@example.com",
          attempts: 1,
          idempotencyKey: randomUUID(),
        }),
      ),
    ).toBe(CHECK_VIOLATION);
  });
});
