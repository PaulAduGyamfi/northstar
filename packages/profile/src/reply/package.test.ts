import { describe, expect, it } from "vitest";
import { replyPackage } from "./package.js";
import type { ReplyDraft } from "./schema.js";

// A checked reply draft as the Gate's package (NS-237). Synthetic mail only.

const DRAFT: ReplyDraft = {
  sentences: [
    { text: "Hi Jo,", cites: [] },
    {
      text: "I led the billing migration.",
      cites: [{ id: "atom-1", quote: "Led the billing migration" }],
    },
    {
      text: "I also cut costs.",
      cites: [
        { id: "story-2", quote: "cut costs" },
        { id: "atom-1", quote: "billing" },
      ],
    },
  ],
  followUps: ["Which week suits you?"],
};

const INBOUND = {
  from: "Jo Recruiter <jo@acme.example>",
  replyTo: null,
  subject: "Your application at Acme",
  messageId: "<m2@acme.example>",
  references: null,
};

describe("replyPackage", () => {
  it("builds the envelope from the headers, the body from the sentences and each cite once", () => {
    expect(
      replyPackage({
        gmailMessageId: "18c3f0a2b4d6e8f0",
        threadId: "18c3f0a2b4d6e8aa",
        inbound: INBOUND,
        draft: DRAFT,
      }),
    ).toEqual({
      ok: true,
      value: {
        gmailMessageId: "18c3f0a2b4d6e8f0",
        threadId: "18c3f0a2b4d6e8aa",
        envelope: {
          to: "jo@acme.example",
          subject: "Re: Your application at Acme",
          inReplyTo: "<m2@acme.example>",
          references: ["<m2@acme.example>"],
        },
        body: "Hi Jo, I led the billing migration. I also cut costs.",
        cites: ["atom-1", "story-2"],
        followUps: ["Which week suits you?"],
      },
    });
  });

  it("gives the envelope's refusal for a sender that isn't one plain address", () => {
    expect(
      replyPackage({
        gmailMessageId: "18c3f0a2b4d6e8f0",
        threadId: "18c3f0a2b4d6e8aa",
        inbound: { ...INBOUND, from: "a@acme.example, b@acme.example" },
        draft: DRAFT,
      }),
    ).toEqual({ ok: false, error: { kind: "InvalidReply", fields: ["from"] } });
  });
});
