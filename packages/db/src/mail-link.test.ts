import { CandidateId } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { mailLink, mailTag } from "./mail-link-schema.js";
import {
  assignTag,
  listConfirmQueue,
  readLinkedThreads,
  readTags,
  recordMailLink,
} from "./mail-link-write.js";
import { application, domainEvent } from "./schema.js";
import { createTestDb, seedApplication, sqlState } from "./test/pglite.js";

// The mail-link write path on PGlite (NS-158). Synthetic ids only.

const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let applicationId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const seeded = await seedApplication(db, "submitted");
  candidateId = CandidateId.parse(seeded.candidateId);
  applicationId = seeded.applicationId;
});

afterEach(async () => {
  await close();
});

// A generator that hands out the given tags in order.
const tags = (...list: string[]) => {
  let i = 0;
  return () => list[i++] ?? "zzzzzz";
};

const AT = new Date("2026-11-25T12:00:00Z");
const message = (id: string, threadId = "aa01") => ({ id, threadId, receivedAt: AT });

describe("assignTag", () => {
  it("gives an application a tag, and the same one when asked again", async () => {
    const first = await assignTag(db, {
      candidateId,
      target: { applicationId },
      newTag: tags("k3q2m7"),
    });
    const again = await assignTag(db, {
      candidateId,
      target: { applicationId },
      newTag: tags("abcdef"),
    });
    expect([first, again]).toEqual([
      { tag: "k3q2m7", created: true },
      { tag: "k3q2m7", created: false },
    ]);
  });

  it("gives a tenant its own tag", async () => {
    const t = await assignTag(db, {
      candidateId,
      target: { tenantKey: "workday:acme" },
      newTag: tags("wrkday"),
    });
    expect(await readTags(db, candidateId)).toEqual([
      { tag: t.tag, applicationId: null, tenantKey: "workday:acme" },
    ]);
  });

  it("tries a fresh tag when the first one is taken", async () => {
    await assignTag(db, {
      candidateId,
      target: { tenantKey: "workday:acme" },
      newTag: tags("k3q2m7"),
    });
    const second = await assignTag(db, {
      candidateId,
      target: { applicationId },
      newTag: tags("k3q2m7", "abcdef"),
    });
    expect(second).toEqual({ tag: "abcdef", created: true });
  });

  it("refuses a generator that returns something that isn't a tag", async () => {
    await expect(
      assignTag(db, { candidateId, target: { applicationId }, newTag: () => "ACME01" }),
    ).rejects.toThrow("newTag returned something that isn't a mail tag");
  });

  it("refuses a tag aimed at both an application and a tenant", async () => {
    const state = await sqlState(
      db
        .insert(mailTag)
        .values({ candidateId, tag: "abcdef", applicationId, tenantKey: "workday:acme" }),
    );
    expect(state).toBe(CHECK_VIOLATION);
  });
});

describe("recordMailLink", () => {
  it("records a link once: a repeat stores nothing and writes no second event", async () => {
    const input = {
      candidateId,
      message: message("ff01"),
      decision: {
        kind: "linked" as const,
        applicationId,
        step: "tag" as const,
        senderVerified: true,
      },
    };
    const first = await recordMailLink(db, input);
    const second = await recordMailLink(db, input);
    const rows = await db.select().from(mailLink);
    const events = await db.select().from(domainEvent).where(eq(domainEvent.type, "mail.linked"));
    expect([first, second, rows.length, events.length]).toEqual([
      { recorded: true },
      { recorded: false },
      1,
      1,
    ]);
  });

  it("writes a linked event with ids, step and verification only", async () => {
    await recordMailLink(db, {
      candidateId,
      message: message("ff01"),
      decision: { kind: "linked", applicationId, step: "sender", senderVerified: false },
    });
    const [event] = await db.select().from(domainEvent).where(eq(domainEvent.type, "mail.linked"));
    expect(event?.payload).toEqual({
      gmailMessageId: "ff01",
      applicationId,
      step: "sender",
      senderVerified: false,
    });
  });

  it("never changes the application's status (INB-004, P1)", async () => {
    await recordMailLink(db, {
      candidateId,
      message: message("ff01"),
      decision: { kind: "linked", applicationId, step: "tag", senderVerified: true },
    });
    const [row] = await db.select({ status: application.status }).from(application);
    expect(row?.status).toBe("submitted");
  });

  it("puts queued mail in the confirm queue, oldest first", async () => {
    await recordMailLink(db, {
      candidateId,
      message: { id: "ff02", threadId: "aa02", receivedAt: new Date("2026-11-25T13:00:00Z") },
      decision: { kind: "queued", reason: "ambiguous" },
    });
    await recordMailLink(db, {
      candidateId,
      message: message("ff01"),
      decision: { kind: "queued", reason: "unknown_tag" },
    });
    const queue = await listConfirmQueue(db, candidateId);
    expect(queue.map((q) => [q.gmailMessageId, q.reason])).toEqual([
      ["ff01", "unknown_tag"],
      ["ff02", "ambiguous"],
    ]);
  });

  it("lists the threads already linked to each application", async () => {
    await recordMailLink(db, {
      candidateId,
      message: message("ff01", "aa07"),
      decision: { kind: "linked", applicationId, step: "tag", senderVerified: true },
    });
    expect([...(await readLinkedThreads(db, candidateId))]).toEqual([[applicationId, ["aa07"]]]);
  });

  it("refuses a Gmail id that isn't a hex id", async () => {
    const state = await sqlState(
      recordMailLink(db, {
        candidateId,
        message: message("<subject@example.com>"),
        decision: { kind: "queued", reason: "no_match" },
      }),
    );
    expect(state).toBe(CHECK_VIOLATION);
  });
});

describe("mail tag and link tables", () => {
  it("refuse changing or deleting a tag", async () => {
    await assignTag(db, { candidateId, target: { applicationId }, newTag: tags("k3q2m7") });
    expect([
      await sqlState(db.update(mailTag).set({ tag: "abcdef" })),
      await sqlState(db.delete(mailTag)),
      await sqlState(db.execute(sql`truncate mail_tag cascade`)),
    ]).toEqual([RESTRICT_VIOLATION, RESTRICT_VIOLATION, RESTRICT_VIOLATION]);
  });

  it("refuse changing or deleting a link", async () => {
    await recordMailLink(db, {
      candidateId,
      message: message("ff01"),
      decision: { kind: "queued", reason: "no_match" },
    });
    expect([
      await sqlState(db.update(mailLink).set({ queueReason: "ambiguous" })),
      await sqlState(db.delete(mailLink)),
      await sqlState(db.execute(sql`truncate mail_link`)),
    ]).toEqual([RESTRICT_VIOLATION, RESTRICT_VIOLATION, RESTRICT_VIOLATION]);
  });
});
