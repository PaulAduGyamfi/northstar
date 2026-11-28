import { CandidateId } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { pushSubscription } from "./push-schema.js";
import {
  countLivePushSubscriptions,
  readLivePushSubscriptions,
  removePushSubscription,
  subscribePush,
} from "./push-write.js";
import { domainEvent } from "./schema.js";
import { createTestDb, seedApplication, sqlState } from "./test/pglite.js";

// Web push subscriptions (NS-193 slice 2). Synthetic endpoints and keys only.

const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  candidateId = CandidateId.parse((await seedApplication(db, "submitted")).candidateId);
});

afterEach(async () => {
  await close();
});

// A P-256 point is 65 bytes starting 0x04: "B" then 86 base64url characters.
const P256DH = `B${"A".repeat(86)}`;
const AUTH = "A".repeat(22);
const sub = (endpoint = "https://fcm.googleapis.com/fcm/send/device-1") => ({
  endpoint,
  p256dh: P256DH,
  auth: AUTH,
});

describe("subscribePush (NS-193 slice 2)", () => {
  it("stores a subscription once, however many times the browser sends it", async () => {
    const first = await subscribePush(db, candidateId, sub());
    const second = await subscribePush(db, candidateId, sub());
    expect([first.ok && first.created, second.ok && second.created]).toEqual([true, false]);
    expect(second.ok && first.ok && second.subscriptionId === first.subscriptionId).toBe(true);
    expect(await countLivePushSubscriptions(db, candidateId)).toBe(1);
  });

  it("refuses an endpoint outside the push allowlist, naming the field", async () => {
    for (const endpoint of ["https://169.254.169.254/latest", "http://fcm.googleapis.com/x"]) {
      expect(await subscribePush(db, candidateId, sub(endpoint))).toEqual({
        ok: false,
        error: { kind: "InvalidSubscription", field: "endpoint" },
      });
    }
  });

  it("refuses keys of the wrong shape, naming the field", async () => {
    expect(await subscribePush(db, candidateId, { ...sub(), p256dh: "abc" })).toEqual({
      ok: false,
      error: { kind: "InvalidSubscription", field: "p256dh" },
    });
    expect(await subscribePush(db, candidateId, { ...sub(), auth: "abc" })).toEqual({
      ok: false,
      error: { kind: "InvalidSubscription", field: "auth" },
    });
  });

  it("writes push.subscribed with the row id only, never the endpoint or keys", async () => {
    const result = await subscribePush(db, candidateId, sub());
    const events = await db
      .select({ type: domainEvent.type, payload: domainEvent.payload, reason: domainEvent.reason })
      .from(domainEvent)
      .where(eq(domainEvent.type, "push.subscribed"));
    expect(events).toEqual([
      {
        type: "push.subscribed",
        payload: { subscriptionId: result.ok ? result.subscriptionId : "" },
        reason: "You turned on notifications in a browser",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("fcm.googleapis.com");
  });

  it("refuses a non-https endpoint at the database too", async () => {
    expect(
      await sqlState(
        db
          .insert(pushSubscription)
          .values({ candidateId, endpoint: "http://example.com/x", p256dh: P256DH, auth: AUTH }),
      ),
    ).toBe(CHECK_VIOLATION);
  });
});

describe("removePushSubscription (NS-193 slice 2)", () => {
  it("removes Paul's subscription by endpoint once, and a later subscribe is a new row", async () => {
    const first = await subscribePush(db, candidateId, sub());
    expect(
      await removePushSubscription(db, candidateId, { endpoint: sub().endpoint }, "user"),
    ).toEqual({
      ok: true,
      removed: true,
    });
    expect(
      await removePushSubscription(db, candidateId, { endpoint: sub().endpoint }, "user"),
    ).toEqual({
      ok: true,
      removed: false,
    });
    expect(await readLivePushSubscriptions(db, candidateId)).toEqual([]);
    const again = await subscribePush(db, candidateId, sub());
    expect(
      again.ok && first.ok && again.created && again.subscriptionId !== first.subscriptionId,
    ).toBe(true);
  });

  it("removes a gone subscription by id and keeps the others", async () => {
    const a = await subscribePush(db, candidateId, sub("https://fcm.googleapis.com/fcm/send/a"));
    await subscribePush(db, candidateId, sub("https://web.push.apple.com/b"));
    if (!a.ok) throw new Error("subscribe failed");
    await removePushSubscription(db, candidateId, { subscriptionId: a.subscriptionId }, "gone");
    expect((await readLivePushSubscriptions(db, candidateId)).map((s) => s.endpoint)).toEqual([
      "https://web.push.apple.com/b",
    ]);
  });

  it("keeps both tables append-only", async () => {
    const a = await subscribePush(db, candidateId, sub());
    if (!a.ok) throw new Error("subscribe failed");
    await removePushSubscription(db, candidateId, { subscriptionId: a.subscriptionId }, "gone");
    expect([
      await sqlState(db.execute(sql`UPDATE push_subscription SET auth = ${AUTH}`)),
      await sqlState(db.execute(sql`DELETE FROM push_subscription_removal`)),
      await sqlState(db.execute(sql`TRUNCATE push_subscription_removal`)),
    ]).toEqual([RESTRICT_VIOLATION, RESTRICT_VIOLATION, RESTRICT_VIOLATION]);
  });
});
