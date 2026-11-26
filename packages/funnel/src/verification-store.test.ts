import { dbWindowStore, schema } from "@northstar/db";
import { createTestDb } from "@northstar/db/testing";
import { CandidateId } from "@northstar/domain";
import { createStoredCatcher, type WindowStore } from "@northstar/inbox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The inbox's stored catcher on the database's window store (NS-151), on PGlite. This package is
// the one that already depends on both; the gateway session that wires them comes with NS-142.
// Synthetic tenant and mail only.

const T0 = new Date("2026-11-25T12:00:00Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);
const SPEC = {
  tenant: "Acme",
  ats: "Workday",
  purpose: "sign_up" as const,
  senderDomains: ["myworkday.com"],
  linkHosts: ["acme.wd5.myworkdayjobs.com"],
};
const mail = (messageId: string, receivedAt: Date) => ({
  messageId,
  senderDomain: "myworkday.com",
  authenticationResults:
    "mx.google.com; dkim=pass header.d=myworkday.com; dmarc=pass header.from=myworkday.com",
  receivedAt,
  text: "Your verification code is 482913.",
  html: null,
});

let test: Awaited<ReturnType<typeof createTestDb>>;
let store: WindowStore;

beforeEach(async () => {
  test = await createTestDb();
  const [c] = await test.db.insert(schema.candidate).values({ displayName: "Test" }).returning();
  if (!c) throw new Error("no candidate");
  store = dbWindowStore(test.db, CandidateId.parse(c.id));
});

afterEach(async () => {
  await test.close();
});

describe("the stored catcher on the database", () => {
  it("is shared by two catchers: one opens the window, the other catches the code once", async () => {
    let clock = T0;
    const gateway = createStoredCatcher({ store, now: () => clock });
    const mailReader = createStoredCatcher({ store, now: () => clock });
    const w = await gateway.open(SPEC);
    clock = minutes(1);
    const [first, second] = await Promise.all([
      mailReader.offer(mail("m-1", minutes(1))),
      gateway.offer(mail("m-1", minutes(1))),
    ]);
    expect([first?.status, second?.status].sort()).toEqual(["not_verification", "verified"]);
    expect(await gateway.timeout(w.id)).toEqual({ action: "closed", windowId: w.id });
  });

  it("survives a restart: a new catcher resends once, then hands Paul the step", async () => {
    let clock = T0;
    const w = await createStoredCatcher({ store, now: () => clock }).open(SPEC);
    clock = minutes(10);
    const afterRestart = createStoredCatcher({ store, now: () => clock });
    expect(await afterRestart.timeout(w.id)).toEqual({
      action: "resend",
      windowId: w.id,
      expiresAt: minutes(20),
    });
    clock = minutes(20);
    expect(await afterRestart.timeout(w.id)).toMatchObject({
      action: "needs_human",
      reason: "no_email",
    });
  });
});
