import { describe, expect, it } from "vitest";
import { generateMailTag, isTaggableAddress, MAIL_TAG_PATTERN, taggedAddress } from "./mail-tag.js";

describe("generateMailTag", () => {
  it("gives 6 base32 characters, different from call to call", () => {
    const tags = Array.from({ length: 200 }, () => generateMailTag());
    expect([tags.every((t) => MAIL_TAG_PATTERN.test(t)), new Set(tags).size]).toEqual([true, 200]);
  });
});

describe("taggedAddress", () => {
  it("puts +ns-<tag> before the @", () => {
    expect(taggedAddress("candidate@example.com", "k3q2m7")).toBe(
      "candidate+ns-k3q2m7@example.com",
    );
  });

  it.each(["candidate+jobs@example.com", "no-at-sign", "@example.com", "a b@example.com"])(
    "refuses %j as a base address",
    (base) => {
      expect(isTaggableAddress(base)).toBe(false);
      expect(() => taggedAddress(base, "k3q2m7")).toThrow("not a plain email address");
    },
  );

  it("refuses a tag that isn't one", () => {
    expect(() => taggedAddress("candidate@example.com", "ACME01")).toThrow("not a mail tag");
  });
});
