import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { DraftInputError } from "./errors.js";
import { buildDraftMessage } from "./message.js";
import { composeAccess, DECISION, PACKAGE } from "./test/fixtures.js";

const decode = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");

describe("buildDraftMessage (NS-237 slice 4)", () => {
  it("encodes a subject that isn't ASCII as one RFC 2047 word", () => {
    const raw = buildDraftMessage({
      envelope: { ...PACKAGE.envelope, subject: "Re: Café role" },
      body: PACKAGE.body,
      decisionId: DECISION,
    });
    const subject = decode(raw)
      .split("\r\n")
      .find((l) => l.startsWith("Subject: "));
    expect(subject).toBe(`Subject: =?UTF-8?B?${Buffer.from("Re: Café role").toString("base64")}?=`);
  });

  it("splits a long subject that isn't ASCII into encoded words of at most 75 characters", () => {
    const subject = `Re: ${"é".repeat(120)}`;
    const raw = buildDraftMessage({
      envelope: { ...PACKAGE.envelope, subject },
      body: PACKAGE.body,
      decisionId: DECISION,
    });
    const head = decode(raw).split("\r\n\r\n")[0] ?? "";
    const start = head.indexOf("Subject: ") + "Subject: ".length;
    const value = head.slice(start, head.indexOf("\r\nIn-Reply-To:"));
    const words = value.split("\r\n ");
    expect(words.every((w) => /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/.test(w) && w.length <= 75)).toBe(
      true,
    );
    const decoded = words
      .map((w) => Buffer.from(w.slice(10, -2), "base64").toString("utf8"))
      .join("");
    expect(decoded).toBe(subject);
  });

  it("folds a long References chain so no line passes 998 characters", () => {
    const references = Array.from({ length: 20 }, (_, i) => `<${"a".repeat(90)}${i}@example.com>`);
    const raw = buildDraftMessage({
      envelope: { ...PACKAGE.envelope, references },
      body: PACKAGE.body,
      decisionId: DECISION,
    });
    const lines = decode(raw).split("\r\n");
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(998);
    const refs = decode(raw).split("References: ")[1]?.split("\r\nX-Northstar-Approval")[0];
    expect(refs?.split("\r\n ")).toEqual(references);
  });

  it.each([
    ["subject", { ...PACKAGE.envelope, subject: "Re: hi\r\nBcc: someone@example.org" }],
    ["to", { ...PACKAGE.envelope, to: "a@example.com\r\nBcc: someone@example.org" }],
    ["inReplyTo", { ...PACKAGE.envelope, inReplyTo: "<a@example.com>\nBcc: x@example.org" }],
  ])("refuses a %s with a line break, so no header can be added", (_field, envelope) => {
    expect(() => buildDraftMessage({ envelope, body: PACKAGE.body, decisionId: DECISION })).toThrow(
      DraftInputError,
    );
  });

  it("refuses a marker that isn't a decision id", () => {
    expect(() =>
      buildDraftMessage({
        envelope: PACKAGE.envelope,
        body: PACKAGE.body,
        decisionId: "x\r\nBcc:",
      }),
    ).toThrow(new DraftInputError("decisionId"));
  });

  it("keeps the body's own lines inside the base64 part, never as headers", () => {
    const raw = buildDraftMessage({
      envelope: PACKAGE.envelope,
      body: "Hello\r\nBcc: someone@example.org\r\n\r\nBye",
      decisionId: DECISION,
    });
    const head = decode(raw).split("\r\n\r\n")[0] ?? "";
    expect(head).not.toContain("Bcc");
  });
});

describe("GmailComposeAccess", () => {
  it("never prints its token", () => {
    const access = composeAccess();
    expect(String(access)).toBe("[GmailComposeAccess]");
    expect(JSON.stringify({ access })).toBe('{"access":"[GmailComposeAccess]"}');
    expect(inspect(access)).toBe("[GmailComposeAccess]");
  });
});
