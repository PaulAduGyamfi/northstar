import { mailClassifyRoute } from "@northstar/inbox";
import { LlmTransportError } from "@northstar/llm";
import { describe, expect, it } from "vitest";
import { type BackfillDeps, runBackfill } from "./backfill.js";
import { gmailRecords, nameKey } from "./records.js";
import {
  EXPECTED,
  type FakeMessage,
  fakeGmailClient,
  mailbox,
  memoryStore,
  NOW,
  record,
  scriptedGateway,
} from "./test/mailbox.js";

const OPTIONS = { since: "2026-02-01", maxMessages: 500 };

// The whole synthetic mailbox, with a gateway that answers as a correct model would.
function setup() {
  const box = mailbox();
  const gmail = fakeGmailClient(box.messages);
  const gateway = scriptedGateway((input) => {
    const msg = box.messages.find(
      (x) => x.headers.Subject === input.subject && x.text === input.body,
    );
    const output = msg ? box.answers.get(msg.id) : undefined;
    if (!output) throw new Error(`no scripted answer for "${input.subject}"`);
    return { kind: "Ok", output, record: record() };
  });
  const store = memoryStore();
  const printed: string[] = [];
  const deps: BackfillDeps = {
    gmail,
    gateway,
    route: mailClassifyRoute(),
    store,
    print: (l) => printed.push(l),
  };
  return { box, gmail, gateway, store, deps, printed };
}

describe("runBackfill on a synthetic 9-month mailbox", () => {
  it("rebuilds every application's stage and outcome", async () => {
    const { deps, store } = setup();
    await runBackfill(deps, OPTIONS);
    const records = gmailRecords(await store.messages(), NOW);
    const found = EXPECTED.filter((e) =>
      records.some(
        (r) =>
          nameKey(r.company) === nameKey(e.company) &&
          r.stage === e.stage &&
          r.outcome === e.outcome,
      ),
    );
    // DX-001 asks for at least 90%; with correct answers the code must get all 12 right.
    expect(found).toEqual(EXPECTED);
    expect(records).toHaveLength(EXPECTED.length);
  });

  it("never fetches or sends non-job mail to the model", async () => {
    const { box, deps, gmail, gateway } = setup();
    await runBackfill(deps, OPTIONS);
    const newsletterIds = box.messages
      .filter((x) => x.threadId.startsWith("news-"))
      .map((x) => x.id);
    expect(newsletterIds).toHaveLength(3);
    expect(gmail.fullFetches.filter((id) => newsletterIds.includes(id))).toEqual([]);
    const subjects = gateway.calls.map((c) => c.subject);
    for (const s of ["Weekend sale: 30% off", "Dinner on Friday?", "Your monthly statement"]) {
      expect(subjects).not.toContain(s);
    }
  });

  it("classifies standard confirmation subjects by rules, with no model call", async () => {
    const { deps, gateway } = setup();
    const counts = await runBackfill(deps, OPTIONS);
    expect(counts.ruleClassified).toBe(10);
    expect(gateway.calls.some((c) => c.subject.startsWith("Thank you for applying"))).toBe(false);
  });

  it("keeps a thread's follow-ups even when their subjects carry no job phrase", async () => {
    const { deps, store } = setup();
    await runBackfill(deps, OPTIONS);
    const intro = store.rows.find(
      (r) => r.company === "Umbrella Labs" && r.stageSignal === "screen",
    );
    expect(intro?.status).toBe("classified");
  });

  it("sends an extraction whose employer isn't in the email to review, not into a record", async () => {
    const { deps, store } = setup();
    const counts = await runBackfill(deps, OPTIONS);
    const bad = store.rows.find((r) => r.threadId === "bad");
    expect(bad).toMatchObject({
      status: "needs_review",
      reviewReason: "provenance",
      company: null,
    });
    expect(counts.review).toBe(1);
  });

  it("drops a job alert the model calls info_other", async () => {
    const { deps, store } = setup();
    await runBackfill(deps, OPTIONS);
    expect(store.rows.find((r) => r.threadId === "alert")?.status).toBe("not_job");
  });

  it("running it twice adds nothing and calls the model no more", async () => {
    const { deps, store, gateway } = setup();
    await runBackfill(deps, OPTIONS);
    const rows = store.rows.length;
    const calls = gateway.calls.length;
    const second = await runBackfill(deps, OPTIONS);
    expect(store.rows).toHaveLength(rows);
    expect(gateway.calls).toHaveLength(calls);
    expect(second.alreadyKnown).toBe(second.listed);
  });

  it("stops at --max-messages, says so up front, and the next run finishes the rest", async () => {
    const { deps, store, printed } = setup();
    const first = await runBackfill(deps, { ...OPTIONS, maxMessages: 5 });
    expect(first.modelCalls).toBe(5);
    expect(printed[0]).toMatch(/for the model \(about \$0\.10\), \d+ left for the next run/);
    const second = await runBackfill(deps, OPTIONS);
    expect(second.deferred).toBe(0);
    expect(gmailRecords(await store.messages(), NOW)).toHaveLength(EXPECTED.length);
  });

  it("an API outage stops the run and keeps what was already decided", async () => {
    const { deps, store } = setup();
    let calls = 0;
    deps.gateway = scriptedGateway(() => {
      calls += 1;
      return new LlmTransportError({ status: 503, retryable: true });
    });
    await expect(runBackfill(deps, OPTIONS)).rejects.toThrow(LlmTransportError);
    expect(calls).toBe(1);
    // Oldest first: the two confirmations before the first model call (Globex's intro) are stored.
    expect(store.rows.filter((r) => r.classifiedBy === "rules").length).toBe(2);
  });
});

describe("model outcomes other than Ok", () => {
  for (const [kind, reason] of [
    ["Refused", "refused"],
    ["Truncated", "truncated"],
    ["InvalidOutput", "invalid_output"],
  ] as const) {
    it(`a ${kind} answer sends the message to review as ${reason}`, async () => {
      const { deps, store } = setup();
      deps.gateway = scriptedGateway(() =>
        kind === "Refused"
          ? { kind, category: null, record: record() }
          : kind === "Truncated"
            ? { kind, record: record() }
            : { kind, reason: "schema", fields: ["kind"], record: record() },
      );
      await runBackfill(deps, OPTIONS);
      const modelRows = store.rows.filter((r) => r.status === "needs_review");
      expect(modelRows.length).toBeGreaterThan(0);
      expect(modelRows.every((r) => r.reviewReason === reason && r.company === null)).toBe(true);
    });
  }
});

describe("the pre-filter's known gap", () => {
  it("never lists a recruiter's first email in a new thread when its subject has no job phrase", async () => {
    // Narrow on purpose (NFR-SEC-005): personal mail must not reach the model. Paul adds such an
    // application with `funnel import`; later messages in its thread are kept once one is known.
    const { deps, store, gateway } = setup();
    const cold = {
      id: "cold-1",
      threadId: "cold",
      internalDate: "2026-06-02T10:00:00Z",
      headers: { From: "Recruiter <hi@oscorp.example>", Subject: "Quick question" },
      text: "A recruiter at Oscorp would like to talk.",
    };
    deps.gmail = fakeGmailClient([cold]);
    await runBackfill(deps, OPTIONS);
    expect(store.rows).toEqual([]);
    expect(gateway.calls).toEqual([]);
  });
});

describe("verification mail (VER-005)", () => {
  // Synthetic Workday mail for an invented company. Workday's sending domain is a public fact; it
  // is set directly, so no address is written here.
  const workday = (
    id: string,
    threadId: string,
    subject: string,
    verified = true,
  ): FakeMessage => ({
    id,
    threadId,
    internalDate: "2026-04-01T10:00:00Z",
    headers: {
      From: "Acme Careers via Workday",
      Subject: subject,
      ...(verified
        ? { "Authentication-Results": "mx.example; dkim=pass header.d=myworkday.com" }
        : {}),
    },
    text: "Your verification code is 482913.",
    senderDomain: "myworkday.com",
  });

  it("never classifies, fetches or stores verification mail, and counts it", async () => {
    const { deps, store, gmail, gateway } = setup();
    deps.gmail = fakeGmailClient([
      workday("v", "tv", "Acme: verify your email"),
      workday("c", "tc", "Thank you for applying to Acme"),
    ]);
    const counts = await runBackfill(deps, OPTIONS);
    expect(counts.verificationSkipped).toBe(1);
    expect(store.rows.map((r) => [r.gmailId, r.status])).toEqual([["c", "classified"]]);
    expect(gateway.calls).toEqual([]);
    expect((deps.gmail as typeof gmail).fullFetches).toEqual([]);
  });

  it("never sends an ATS body that gives a code to the model, whatever its subject says", async () => {
    const { deps, store, gateway } = setup();
    deps.gmail = fakeGmailClient([workday("v", "tv", "Your Acme account")]);
    const counts = await runBackfill(deps, OPTIONS);
    expect(gateway.calls).toEqual([]);
    expect(store.rows).toEqual([]);
    expect(counts.verificationSkipped).toBe(1);
  });

  it("skips a verification mail found through a job thread", async () => {
    const { deps, store, gmail, gateway } = setup();
    deps.gmail = fakeGmailClient([
      workday("c", "t", "Thank you for applying to Acme"),
      // Unverified, so the search doesn't list it: only the thread listing finds it.
      { ...workday("v", "t", "Your one-time code", false), internalDate: "2026-04-02T10:00:00Z" },
    ]);
    const counts = await runBackfill(deps, OPTIONS);
    expect(counts.fromThreads).toBe(1);
    expect(counts.verificationSkipped).toBe(1);
    expect(store.rows.map((r) => r.gmailId)).toEqual(["c"]);
    expect(gateway.calls).toEqual([]);
    expect((deps.gmail as typeof gmail).fullFetches).toEqual([]);
  });

  it("doesn't make a verification mail's thread a job thread", async () => {
    const { deps, store } = setup();
    deps.gmail = fakeGmailClient([
      workday("v", "t", "Verification code for Acme"),
      {
        id: "other",
        threadId: "t",
        internalDate: "2026-04-02T10:00:00Z",
        headers: { From: "Sam <sam@friend.example>", Subject: "Re: Verification code for Acme" },
        text: "Did it arrive?",
      },
    ]);
    const counts = await runBackfill(deps, OPTIONS);
    expect(counts.fromThreads).toBe(0);
    expect(counts.verificationSkipped).toBe(1);
    expect(store.rows).toEqual([]);
  });
});

describe("hardening", () => {
  const msg = (over: Partial<FakeMessage> & { id: string }): FakeMessage => ({
    threadId: over.id,
    internalDate: "2026-03-02T10:00:00Z",
    headers: {
      From: "Globex <careers@globex.example>",
      Subject: "Thank you for applying to Globex",
    },
    text: "We received your application.",
    ...over,
  });

  it("finds a thread's replies through the thread, though the search never lists them", async () => {
    const { deps, store } = setup();
    deps.gmail = fakeGmailClient([
      msg({ id: "a", threadId: "t" }),
      msg({
        id: "b",
        threadId: "t",
        internalDate: "2026-03-09T10:00:00Z",
        headers: { From: "Globex <careers@globex.example>", Subject: "Intro call" },
        text: "Globex would like a call.",
      }),
    ]);
    deps.gateway = scriptedGateway(() => ({
      kind: "Ok",
      output: {
        kind: "interview_request",
        company: "Globex",
        role: null,
        requisition: null,
        stageSignal: "screen",
      },
      record: record(),
    }));
    const counts = await runBackfill(deps, OPTIONS);
    expect(counts.listed).toBe(1);
    expect(counts.fromThreads).toBe(1);
    expect(store.rows.find((r) => r.gmailId === "b")?.stageSignal).toBe("screen");
  });

  it("sends a confirmation from an unverified sender to the model, not the rules", async () => {
    const { deps, store } = setup();
    deps.gmail = fakeGmailClient([msg({ id: "spoof" })]);
    const gateway = scriptedGateway(() => ({
      kind: "Ok",
      output: {
        kind: "confirmation",
        company: "Globex",
        role: null,
        requisition: null,
        stageSignal: "none",
      },
      record: record(),
    }));
    deps.gateway = gateway;
    await runBackfill(deps, OPTIONS);
    expect(gateway.calls).toHaveLength(1);
    expect(store.rows[0]?.classifiedBy).toBe("model");
  });

  it("puts an unreadable message in a job thread in review, never to the model", async () => {
    const { deps, store } = setup();
    deps.gmail = fakeGmailClient([
      msg({ id: "ok", threadId: "t" }),
      msg({ id: "bad", threadId: "t", internalDate: "not a date", headers: { Subject: "Re:" } }),
    ]);
    const gateway = scriptedGateway(() => ({
      kind: "Ok",
      output: {
        kind: "confirmation",
        company: "Globex",
        role: null,
        requisition: null,
        stageSignal: "none",
      },
      record: record(),
    }));
    deps.gateway = gateway;
    await runBackfill(deps, OPTIONS);
    expect(store.rows.find((r) => r.gmailId === "bad")).toMatchObject({
      status: "needs_review",
      reviewReason: "unparseable",
    });
    expect(gateway.calls).toHaveLength(1);
  });
});
