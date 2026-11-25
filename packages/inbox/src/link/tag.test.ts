import { describe, expect, it } from "vitest";
import { generateTag, TAG_LENGTH, TAG_PATTERN, tagFromDeliveredTo, taggedAddress } from "./tag.js";

describe("generateTag", () => {
  it("is 6 base32 characters", () => {
    for (let i = 0; i < 100; i++) expect(TAG_PATTERN.test(generateTag())).toBe(true);
    expect(generateTag().length).toBe(TAG_LENGTH);
  });

  it("differs from call to call", () => {
    const tags = new Set(Array.from({ length: 200 }, () => generateTag()));
    expect(tags.size).toBe(200);
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
      expect(() => taggedAddress(base, "k3q2m7")).toThrow("not a plain email address");
    },
  );

  it("refuses a tag that isn't one", () => {
    expect(() => taggedAddress("candidate@example.com", "ACME01")).toThrow("not a mail tag");
  });
});

describe("tagFromDeliveredTo", () => {
  it("reads the tag from a bare or named address, in any case", () => {
    expect([
      tagFromDeliveredTo("candidate+ns-k3q2m7@example.com"),
      tagFromDeliveredTo("Candidate <Candidate+NS-K3Q2M7@Example.com>"),
    ]).toEqual([
      { kind: "tag", tag: "k3q2m7" },
      { kind: "tag", tag: "k3q2m7" },
    ]);
  });

  it("says there is no tag for a plain address or no header", () => {
    expect([tagFromDeliveredTo("candidate@example.com"), tagFromDeliveredTo(null)]).toEqual([
      { kind: "none" },
      { kind: "none" },
    ]);
  });

  it.each([
    "candidate+ns-k3q@example.com",
    "candidate+ns-k3q2m71@example.com",
    "c+ns-000000@x.com",
  ])("calls %j malformed, never a guess", (address) => {
    expect(tagFromDeliveredTo(address)).toEqual({ kind: "malformed" });
  });
});
