import { type CallGuard, type GuardDecision, type GuardOutcome, HeldBack } from "@northstar/llm";
import { describe, expect, it } from "vitest";
import { createGmailClient, GMAIL_DEPENDENCY } from "./gmail.js";
import { GmailAccess } from "./oauth.js";
import { type FakeMessage, fakeGmail } from "./test/fake-gmail.js";

// Synthetic mail only (the repo is public).
const message: FakeMessage = {
  id: "m1",
  threadId: "t1",
  internalDate: "2026-03-02T15:00:00Z",
  headers: { From: "Globex Recruiting <no-reply.ats@example.com>", Subject: "Thanks for applying" },
  text: "Hi, we received your application.",
};
const RETRY_AT = new Date("2026-11-25T22:30:00Z");
const limited = JSON.stringify({ error: { errors: [{ reason: "rateLimitExceeded" }] } });

// A guard that answers `decision` and records every report.
function guardWith(decision: GuardDecision = { allowed: true, probe: false }) {
  const reports: { dependency: string; outcome: GuardOutcome; probeToken: string | null }[] = [];
  const acquired: string[] = [];
  const guard: CallGuard = {
    isOn: async () => true,
    acquire: async (dependency) => {
      acquired.push(dependency);
      return decision;
    },
    report: async (dependency, outcome, probeToken) => {
      reports.push({ dependency, outcome, probeToken });
    },
  };
  return { guard, reports, acquired };
}

const clientFor = (gmail: ReturnType<typeof fakeGmail>, guard: CallGuard) =>
  createGmailClient({
    access: new GmailAccess("ya29.test-access-token"),
    fetch: gmail.fetch,
    sleep: async () => {},
    random: () => 0,
    guard,
  });

describe("gmail client with a breaker", () => {
  it("asks the gmail breaker before a read and reports a success", async () => {
    const { guard, reports, acquired } = guardWith();
    await clientFor(fakeGmail([message]), guard).getHeaders("m1");
    expect(acquired).toEqual([GMAIL_DEPENDENCY]);
    expect(GMAIL_DEPENDENCY).toBe("gmail");
    expect(reports).toEqual([{ dependency: "gmail", outcome: { ok: true }, probeToken: null }]);
  });

  it("sends no request while the breaker is open and throws HeldBack with the retry time", async () => {
    const { guard, reports } = guardWith({ allowed: false, retryAt: RETRY_AT, lastError: null });
    const gmail = fakeGmail([message]);
    const error = await clientFor(gmail, guard)
      .getHeaders("m1")
      .catch((e: unknown) => e);
    expect(error).toEqual(new HeldBack("breaker", "gmail", RETRY_AT));
    expect(gmail.requests).toEqual([]);
    expect(reports).toEqual([]);
  });

  it("reads the profile through the breaker too: nothing is sent while it is open", async () => {
    const { guard } = guardWith({ allowed: false, retryAt: RETRY_AT, lastError: null });
    const gmail = fakeGmail([], { emailAddress: "candidate@example.com" });
    const error = await clientFor(gmail, guard)
      .profileAddress()
      .catch((e: unknown) => e);
    expect(error).toEqual(new HeldBack("breaker", "gmail", RETRY_AT));
    expect(gmail.requests).toEqual([]);
  });

  it("reports a profile read's server error that outlasts the retries as Gmail's failure", async () => {
    const { guard, reports } = guardWith();
    const gmail = fakeGmail([], {
      emailAddress: "candidate@example.com",
      failures: Array.from({ length: 6 }, () => ({ status: 503 })),
    });
    await expect(clientFor(gmail, guard).profileAddress()).rejects.toThrow("after 5 retries");
    expect(reports.map((r) => r.outcome)).toEqual([{ ok: false, error: "GmailError" }]);
  });

  it("reports a server error that outlasts the retries as Gmail's failure", async () => {
    const { guard, reports } = guardWith();
    const gmail = fakeGmail([message], {
      failures: Array.from({ length: 6 }, () => ({ status: 503 })),
    });
    await expect(clientFor(gmail, guard).getHeaders("m1")).rejects.toThrow("after 5 retries");
    expect(reports.map((r) => r.outcome)).toEqual([{ ok: false, error: "GmailError" }]);
  });

  it("reports a rate limit that outlasts the retries as Gmail's failure", async () => {
    const { guard, reports } = guardWith();
    const gmail = fakeGmail([message], {
      failures: Array.from({ length: 6 }, () => ({ status: 403, body: limited })),
    });
    await expect(clientFor(gmail, guard).getHeaders("m1")).rejects.toThrow("after 5 retries");
    expect(reports.map((r) => r.outcome)).toEqual([{ ok: false, error: "GmailError" }]);
  });

  it("reports a 404 and an unauthorized read as Gmail working, because the fault is ours", async () => {
    for (const status of [404, 401]) {
      const { guard, reports } = guardWith();
      const gmail = fakeGmail([message], { failures: [{ status }] });
      await expect(clientFor(gmail, guard).getHeaders("m1")).rejects.toThrow(`answered ${status}`);
      expect(reports.map((r) => r.outcome)).toEqual([{ ok: true }]);
    }
  });

  it("passes a probe's token back with its report", async () => {
    const { guard, reports } = guardWith({ allowed: true, probe: true, probeToken: "tok-1" });
    await clientFor(fakeGmail([message]), guard).getFull("m1");
    expect(reports).toEqual([{ dependency: "gmail", outcome: { ok: true }, probeToken: "tok-1" }]);
  });

  it("guards each page of a listing as its own read", async () => {
    const { guard, reports } = guardWith();
    const many = Array.from({ length: 3 }, (_, i) => ({ ...message, id: `m${i}` }));
    await clientFor(fakeGmail(many, { pageSize: 2 }), guard).listIds("from:example.com");
    expect(reports.map((r) => r.outcome)).toEqual([{ ok: true }, { ok: true }]);
  });

  it("holds the read back when the breaker check throws", async () => {
    const guard: CallGuard = {
      isOn: async () => true,
      acquire: async () => {
        throw new Error("db down");
      },
      report: async () => {},
    };
    const gmail = fakeGmail([message]);
    await expect(clientFor(gmail, guard).getHeaders("m1")).rejects.toEqual(
      new HeldBack("guard_error", "gmail"),
    );
    expect(gmail.requests).toEqual([]);
  });

  it("returns the read when the report itself fails", async () => {
    const guard: CallGuard = {
      isOn: async () => true,
      acquire: async () => ({ allowed: true, probe: false }),
      report: async () => {
        throw new Error("db down");
      },
    };
    const headers = await clientFor(fakeGmail([message]), guard).getHeaders("m1");
    expect(headers.id).toBe("m1");
  });
});
