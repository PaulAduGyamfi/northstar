import { describe, expect, it } from "vitest";
import { type HandoffItem, handoffCards, safeHref } from "./handoffs";

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
