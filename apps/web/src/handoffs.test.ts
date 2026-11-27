import { describe, expect, it } from "vitest";
import {
  countdown,
  grantMessage,
  type HandoffItem,
  handoffCards,
  prefillCode,
  safeHref,
  secondsLeft,
} from "./handoffs";

// The "Needs your hands" card's plain logic (NS-121). Synthetic ids and example links only.
const item = (over: Partial<HandoffItem> = {}): HandoffItem => ({
  handoffId: "0b6f3f8e-6a55-4c7e-9a52-5d6b2f8a1c01",
  applicationId: "5c1e2a7d-3b4f-4e8a-9c6d-7f0a1b2c3d4e",
  ats: "greenhouse",
  reason: "captcha",
  applyUrl: "https://boards.greenhouse.io/example/jobs/123",
  createdAt: "2026-11-25T12:00:00.000Z",
  ...over,
});

describe("safeHref", () => {
  it("keeps an https link", () => {
    expect(safeHref("https://jobs.example.com/apply/1")).toBe("https://jobs.example.com/apply/1");
  });

  it("drops anything that isn't https", () => {
    expect(
      ["javascript:alert(1)", "http://jobs.example.com/1", "data:text/html,x", "not a url"].map(
        safeHref,
      ),
    ).toEqual([null, null, null, null]);
  });
});

describe("handoffCards", () => {
  it("says which form stopped and why, in plain words, with its link", () => {
    const second = item({
      handoffId: "7a2c9e41-1d3b-4f6a-8e5c-2b9d0f1a3c55",
      ats: "ashby",
      reason: "mfa",
      applyUrl: "https://jobs.ashbyhq.com/example/456",
    });
    expect(handoffCards([item(), second])).toEqual([
      {
        handoffId: "0b6f3f8e-6a55-4c7e-9a52-5d6b2f8a1c01",
        title: "Greenhouse form: a CAPTCHA",
        href: "https://boards.greenhouse.io/example/jobs/123",
      },
      {
        handoffId: "7a2c9e41-1d3b-4f6a-8e5c-2b9d0f1a3c55",
        title: "Ashby form: a verification code",
        href: "https://jobs.ashbyhq.com/example/456",
      },
    ]);
  });

  it("shows no link for a handoff whose link isn't https", () => {
    expect(handoffCards([item({ applyUrl: "javascript:alert(1)" })])[0]?.href).toBeNull();
  });

  it("falls back to plain words for an ATS or reason it doesn't know", () => {
    expect(handoffCards([item({ ats: "", reason: "odd" })])[0]?.title).toBe(
      "Application form: a check only you can pass",
    );
  });
});

describe("prefillCode", () => {
  const HANDOFF = "0b6f3f8e-6a55-4c7e-9a52-5d6b2f8a1c01";
  const GRANT = "g".repeat(43);

  it("joins the handoff id and grant with a dot, the shape the extension reads", () => {
    expect(prefillCode(HANDOFF, GRANT)).toBe(`${HANDOFF}.${GRANT}`);
  });

  it("refuses an id or grant of any other shape", () => {
    expect([
      prefillCode("not-a-uuid", GRANT),
      prefillCode(HANDOFF, "g".repeat(42)),
      prefillCode(HANDOFF, `${"g".repeat(42)}.`),
    ]).toEqual([null, null, null]);
  });
});

describe("the pre-fill countdown", () => {
  const now = Date.parse("2026-11-27T04:00:00.000Z");

  it("counts whole seconds down to the grant's expiry and stops at zero", () => {
    expect([
      secondsLeft("2026-11-27T04:02:00.000Z", now),
      secondsLeft("2026-11-27T04:00:00.400Z", now),
      secondsLeft("2026-11-27T03:59:00.000Z", now),
      secondsLeft("not a time", now),
    ]).toEqual([120, 1, 0, 0]);
  });

  it("shows minutes and seconds", () => {
    expect([countdown(120), countdown(65), countdown(9)]).toEqual(["2:00", "1:05", "0:09"]);
  });
});

describe("grantMessage", () => {
  it("says why no code was given, in plain words", () => {
    expect([
      grantMessage(401, null),
      grantMessage(409, "closed"),
      grantMessage(409, "changed"),
      grantMessage(500, null),
    ]).toEqual([
      "You've been signed out. Sign in again.",
      "That handoff is already closed.",
      "The package changed after you approved it, so it can't be pre-filled.",
      "Couldn't get a pre-fill code. Try again.",
    ]);
  });
});
