import { taggedAddress as domainTagged, MAIL_TAG_PATTERN } from "@northstar/domain";
import { taggedAddress as inboxTagged, TAG_PATTERN } from "@northstar/inbox";
import { describe, expect, it } from "vitest";

// packages/domain keeps a copy of packages/inbox's tag rules for the package caller and the Gate
// (NS-248), since neither depends on packages/inbox. This package depends on both, so it holds
// the two copies to the same answers. Synthetic addresses only.

const outcome = (tag: (base: string, t: string) => string, base: string, t: string) => {
  try {
    return tag(base, t);
  } catch (error) {
    return error instanceof Error ? `error: ${error.message}` : "error";
  }
};

describe("mail tag parity", () => {
  it("the domain's and the inbox's tag patterns are the same", () => {
    expect(MAIL_TAG_PATTERN.source).toBe(TAG_PATTERN.source);
  });

  it.each([
    ["candidate@example.com", "k3q2m7"],
    ["first.last@example.com", "a2b3c4"],
    ["candidate+jobs@example.com", "k3q2m7"],
    ["no-at-sign", "k3q2m7"],
    ["@example.com", "k3q2m7"],
    ["candidate@", "k3q2m7"],
    ["a b@example.com", "k3q2m7"],
    ["a<b@example.com", "k3q2m7"],
    ["candidate@example.com", "ACME01"],
    ["candidate@example.com", "k3q2m"],
  ])("both tag %j with %j the same way", (base, tag) => {
    expect(outcome(domainTagged, base, tag)).toBe(outcome(inboxTagged, base, tag));
  });
});
