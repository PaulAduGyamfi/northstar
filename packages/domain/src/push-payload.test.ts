import { describe, expect, it } from "vitest";
import { APPLY_ATS } from "./apply-package.js";
import { feedLine } from "./feed.js";
import {
  ageText,
  encodePushPayload,
  MAX_FRESH_AGE_MINUTES,
  MAX_PUSH_PAYLOAD_BYTES,
  PUSH_CHALLENGES,
  PUSH_REQUEST_KINDS,
  type PushPayload,
  pushPath,
  pushWords,
} from "./push-payload.js";

const ID = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
const handoff = { v: 1, kind: "handoff", id: ID, ats: "greenhouse", reason: "captcha" } as const;

describe("encodePushPayload (NS-193, ADR-0032 item 4)", () => {
  it("encodes a handoff push as its kind, id and codes only", () => {
    expect(encodePushPayload(handoff)).toBe(
      `{"v":1,"kind":"handoff","id":"${ID}","ats":"greenhouse","reason":"captcha"}`,
    );
  });

  it("refuses any extra field, so no URL, company or job title can ride along", () => {
    for (const extra of [
      { url: "https://boards.greenhouse.io/acme/jobs/1" },
      { applyUrl: "https://example.com/apply" },
      { company: "Acme" },
      { title: "Staff Engineer" },
      { jobTitle: "Staff Engineer" },
      { body: "Hi Paul, your code is 123456" },
    ]) {
      expect(encodePushPayload({ ...handoff, ...extra })).toBeNull();
    }
  });

  it("refuses a URL, name or free text in place of a code", () => {
    expect(encodePushPayload({ ...handoff, ats: "https://evil.example.com" })).toBeNull();
    expect(encodePushPayload({ ...handoff, ats: "Acme Corp" })).toBeNull();
    expect(encodePushPayload({ ...handoff, reason: "open https://evil.example.com" })).toBeNull();
    expect(encodePushPayload({ ...handoff, id: "https://evil.example.com" })).toBeNull();
    expect(encodePushPayload({ ...handoff, kind: "custom" })).toBeNull();
    expect(encodePushPayload({ ...handoff, v: 2 })).toBeNull();
  });

  it("refuses a challenge that isn't one a handoff opens for", () => {
    expect(encodePushPayload({ ...handoff, reason: "driver_error" })).toBeNull();
  });

  it("keeps every possible handoff push under the size cap, with no ':' or '/' beyond the JSON", () => {
    for (const ats of APPLY_ATS) {
      for (const reason of PUSH_CHALLENGES) {
        const json = encodePushPayload({ ...handoff, ats, reason });
        expect(json).not.toBeNull();
        expect(Buffer.byteLength(json ?? "", "utf8")).toBeLessThanOrEqual(MAX_PUSH_PAYLOAD_BYTES);
        expect(json).not.toMatch(/https?:|\/\/|www\./);
      }
    }
  });
});

describe("pushWords (NS-193)", () => {
  it("says which ATS form stopped and why, in the feed's own words", () => {
    const words = pushWords(handoff);
    expect(words).toEqual({
      title: "Needs your hands",
      body: "A Greenhouse form stopped at a CAPTCHA. Open Northstar to finish it.",
      tag: `handoff:${ID}`,
    });
    for (const ats of APPLY_ATS) {
      for (const reason of PUSH_CHALLENGES) {
        const p: PushPayload = { ...handoff, ats, reason };
        const feed = feedLine({
          type: "handoff.opened",
          actor: "agent:apply",
          reason: "",
          payload: { ats, reason },
        });
        // "Needs your hands: a Greenhouse form stopped at a CAPTCHA" ↔ the push's body.
        const fromFeed = feed.replace(/^Needs your hands: a/, "A");
        expect(pushWords(p).body).toBe(`${fromFeed}. Open Northstar to finish it.`);
      }
    }
  });
});

describe("approval pushes (NS-204)", () => {
  it("encodes an approval push as its kind, id and request kind only", () => {
    expect(encodePushPayload({ v: 1, kind: "approval", id: ID, request: "email_reply" })).toBe(
      `{"v":1,"kind":"approval","id":"${ID}","request":"email_reply"}`,
    );
  });

  it("refuses a subject, a draft, a URL, a bad id and the vault reveal", () => {
    const base = { v: 1, kind: "approval", id: ID, request: "application_package" };
    expect([
      encodePushPayload({ ...base, subject: "Example Corp, Staff Engineer" }),
      encodePushPayload({ ...base, body: "Hi Jo, thanks for reaching out" }),
      encodePushPayload({ ...base, url: "https://evil.example.com" }),
      encodePushPayload({ ...base, id: "not-a-uuid" }),
      encodePushPayload({ ...base, request: "vault_reveal" }),
    ]).toEqual([null, null, null, null, null]);
  });

  it("keeps every approval push under the size cap", () => {
    for (const request of PUSH_REQUEST_KINDS) {
      const json = encodePushPayload({ v: 1, kind: "approval", id: ID, request });
      expect(json !== null && Buffer.byteLength(json) <= MAX_PUSH_PAYLOAD_BYTES).toBe(true);
    }
  });

  it("words a request in fixed words and opens it in the Queue", () => {
    const p = { v: 1, kind: "approval", id: ID, request: "application_package" } as const;
    expect([pushWords(p), pushPath(p)]).toEqual([
      {
        title: "Waiting for your approval",
        body: "An application is waiting for you. Open it to review and approve.",
        tag: `approval:${ID}`,
      },
      `/approvals?request=${ID}`,
    ]);
  });
});

const fresh = { v: 1, kind: "fresh_job", id: ID, age: 12, fit: 88 } as const;

describe("a fresh-job push (NS-199 item 1, SRC-015)", () => {
  it("encodes as its kind, the job's id, its age and its fit score only", () => {
    expect(encodePushPayload(fresh)).toBe(
      `{"v":1,"kind":"fresh_job","id":"${ID}","age":12,"fit":88}`,
    );
  });

  it("refuses a title, company, place or link riding along", () => {
    for (const extra of [
      { title: "Staff Engineer" },
      { company: "Acme" },
      { location: "Remote" },
      { url: "https://boards.greenhouse.io/acme/jobs/1" },
      { ats: "greenhouse" },
    ]) {
      expect(encodePushPayload({ ...fresh, ...extra })).toBeNull();
    }
  });

  it("refuses text, fractions and numbers out of range in place of its numbers", () => {
    for (const bad of [
      { age: "12 min ago" },
      { age: 12.5 },
      { age: -1 },
      { age: MAX_FRESH_AGE_MINUTES + 1 },
      { fit: "88" },
      { fit: 88.5 },
      { fit: -1 },
      { fit: 101 },
      { id: "https://evil.example.com" },
    ]) {
      expect(encodePushPayload({ ...fresh, ...bad })).toBeNull();
    }
  });

  it("stays under the size cap at its longest", () => {
    const json = encodePushPayload({ ...fresh, age: MAX_FRESH_AGE_MINUTES, fit: 100 });
    expect(Buffer.byteLength(json ?? "x".repeat(1000), "utf8")).toBeLessThanOrEqual(
      MAX_PUSH_PAYLOAD_BYTES,
    );
  });

  it("is worded with the feed line's own numbers, never the job's name", () => {
    expect(pushWords(fresh)).toEqual({
      title: "A fresh job fits you",
      body: "Posted 12 min ago · Fit 88. Open Northstar to see it.",
      tag: `fresh_job:${ID}`,
    });
    expect(pushWords({ ...fresh, age: 90 }).body).toBe(
      "Posted 1 h ago · Fit 88. Open Northstar to see it.",
    );
  });
});

describe("ageText (moved from packages/db, NS-199)", () => {
  it("says minutes under an hour, whole hours under two days, then whole days", () => {
    expect([ageText(0), ageText(59.9), ageText(60), ageText(47 * 60), ageText(72 * 60)]).toEqual([
      "0 min ago",
      "59 min ago",
      "1 h ago",
      "47 h ago",
      "3 days ago",
    ]);
  });
});
