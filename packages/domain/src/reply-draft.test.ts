import { describe, expect, it } from "vitest";
import {
  type InboundHeaders,
  parseReplyPackage,
  type ReplyPackage,
  replyContentSha256,
  replyEnvelope,
  replySubject,
  replyToOtherDomain,
} from "./reply-draft.js";

// A reply draft's envelope and hash (NS-237). Synthetic addresses only.

const INBOUND: InboundHeaders = {
  from: "Jo Recruiter <jo@acme.example>",
  replyTo: null,
  subject: "Your application at Acme",
  messageId: "<m2@acme.example>",
  references: "<m1@acme.example>",
};

const PKG: ReplyPackage = {
  gmailMessageId: "18c3f0a2b4d6e8f0",
  threadId: "18c3f0a2b4d6e8aa",
  envelope: {
    to: "jo@acme.example",
    subject: "Re: Your application at Acme",
    inReplyTo: "<m2@acme.example>",
    references: ["<m1@acme.example>", "<m2@acme.example>"],
  },
  replyToOtherDomain: false,
  body: "Hi Jo, thank you for reaching out.",
  cites: [],
  followUps: [],
};

describe("replyEnvelope", () => {
  it("answers the sender with Re: and the thread's references", () => {
    expect(replyEnvelope(INBOUND)).toEqual({ ok: true, value: PKG.envelope });
  });

  it("answers Reply-To when the sender gives one, and keeps an existing Re:", () => {
    expect(
      replyEnvelope({
        ...INBOUND,
        replyTo: "talent@acme.example",
        subject: "RE: Your application",
        references: null,
      }),
    ).toEqual({
      ok: true,
      value: {
        to: "talent@acme.example",
        subject: "RE: Your application",
        inReplyTo: "<m2@acme.example>",
        references: ["<m2@acme.example>"],
      },
    });
  });

  it("keeps the newest 20 references and the incoming message last, once", () => {
    const earlier = Array.from({ length: 25 }, (_, i) => `<r${i}@acme.example>`);
    const result = replyEnvelope({
      ...INBOUND,
      references: [...earlier, "<m2@acme.example>"].join(" "),
    });
    const refs = result.ok ? result.value.references : [];
    expect([
      refs.length,
      refs.at(-1),
      refs.filter((r) => r === "<m2@acme.example>").length,
    ]).toEqual([20, "<m2@acme.example>", 1]);
  });

  it("refuses a sender that isn't one plain address, naming the header", () => {
    const refusals = [
      "a@acme.example, b@acme.example",
      "<a@acme.example> <b@acme.example>",
      "Not an address",
      "Jo <jo@acme.example>\r\nBcc: x@evil.example",
      "talent@acme.example, <x@evil.example>",
      "<x@evil.example>, talent@acme.example",
      "a@acme.example <b@evil.example>",
      "jo%evil.example@acme.example",
    ].map((from) => replyEnvelope({ ...INBOUND, from }));
    expect(refusals).toEqual(
      Array(8).fill({ ok: false, error: { kind: "InvalidReply", fields: ["from"] } }),
    );
  });

  it("allows a quoted display name with a comma around the one address", () => {
    const result = replyEnvelope({ ...INBOUND, from: '"Recruiter, Jo" <jo@acme.example>' });
    expect(result.ok && result.value.to).toBe("jo@acme.example");
  });

  it("refuses a bad Reply-To rather than answering From instead", () => {
    expect(replyEnvelope({ ...INBOUND, replyTo: "two@a.example, three@b.example" })).toEqual({
      ok: false,
      error: { kind: "InvalidReply", fields: ["replyTo"] },
    });
  });

  it("refuses a subject that goes past 300 characters with its Re:", () => {
    expect(replyEnvelope({ ...INBOUND, subject: "x".repeat(297) })).toEqual({
      ok: false,
      error: { kind: "InvalidReply", fields: ["subject"] },
    });
  });

  it("names every bad header: subject, Message-ID and references", () => {
    expect(
      replyEnvelope({
        ...INBOUND,
        subject: "Line\nbreak",
        messageId: "no-brackets@acme.example",
        references: "<ok@acme.example> broken",
      }),
    ).toEqual({
      ok: false,
      error: { kind: "InvalidReply", fields: ["subject", "messageId", "references"] },
    });
  });
});

describe("the reply package", () => {
  it("hashes what the writer uses: message, thread, recipient, subject, headers and body", () => {
    const base = replyContentSha256(PKG);
    expect([
      base ===
        replyContentSha256({
          ...PKG,
          cites: ["atom-1"],
          followUps: ["When?"],
          replyToOtherDomain: true,
        }),
      base === replyContentSha256({ ...PKG, threadId: "18c3f0a2b4d6e8bb" }),
      base === replyContentSha256({ ...PKG, body: "Hi Jo." }),
      base === replyContentSha256({ ...PKG, envelope: { ...PKG.envelope, to: "x@acme.example" } }),
      base ===
        replyContentSha256({
          ...PKG,
          envelope: { ...PKG.envelope, references: ["<m2@acme.example>"] },
        }),
      /^[0-9a-f]{64}$/.test(base),
    ]).toEqual([true, false, false, false, false, true]);
  });

  it("keys the Gate subject by the Gmail message id, as a stable version 8 UUID", () => {
    const subject = replySubject(PKG.gmailMessageId);
    expect([
      /^email_reply:[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        subject,
      ),
      subject === replySubject(PKG.gmailMessageId),
      subject === replySubject("18c3f0a2b4d6e8f1"),
    ]).toEqual([true, true, false]);
  });

  it("refuses a package with a bad field, naming it", () => {
    expect(parseReplyPackage({ ...PKG, gmailMessageId: "not-hex", body: "Tab\there" })).toEqual({
      ok: false,
      error: { kind: "InvalidReply", fields: ["gmailMessageId", "body"] },
    });
  });
});

describe("replyToOtherDomain", () => {
  it("flags a Reply-To on another domain than From, and nothing else", () => {
    expect([
      replyToOtherDomain(INBOUND),
      replyToOtherDomain({ ...INBOUND, replyTo: "talent@ACME.example" }),
      replyToOtherDomain({ ...INBOUND, replyTo: "jobs@elsewhere.example" }),
      replyToOtherDomain({ ...INBOUND, replyTo: "not an address" }),
    ]).toEqual([false, false, true, true]);
  });
});
