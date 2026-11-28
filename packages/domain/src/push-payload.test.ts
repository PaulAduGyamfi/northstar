import { describe, expect, it } from "vitest";
import { APPLY_ATS } from "./apply-package.js";
import { feedLine } from "./feed.js";
import {
  encodePushPayload,
  MAX_PUSH_PAYLOAD_BYTES,
  PUSH_CHALLENGES,
  type PushPayload,
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
