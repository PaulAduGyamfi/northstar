import { createHash } from "node:crypto";
import { z } from "zod";
import { err, ok, type Result } from "./result.js";

// A reply draft as the Approval Gate sees it (NS-237, RPL-002, ADR-0002). The envelope is set by
// plain code from the incoming message's own headers, never by the model, and the hash Paul
// approves covers exactly what a later writer puts in the Gmail draft: the recipient, subject,
// thread headers and body.

// A plain address, nothing around it: no display name, comment, list or route.
const ADDRESS = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;
// One Message-ID: angle brackets around printable characters, no spaces.
const MESSAGE_ID = /^<[\x21-\x3b\x3d\x3f-\x7e]{1,995}>$/;
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const MAX_SUBJECT = 300;
const MAX_REFERENCES = 20;

export const ReplyEnvelope = z
  .object({
    to: z.string().max(254).regex(ADDRESS),
    subject: z
      .string()
      .min(1)
      .max(MAX_SUBJECT)
      .refine((s) => !CONTROL.test(s)),
    inReplyTo: z.string().regex(MESSAGE_ID),
    references: z.array(z.string().regex(MESSAGE_ID)).min(1).max(MAX_REFERENCES),
  })
  .strict();
export type ReplyEnvelope = z.infer<typeof ReplyEnvelope>;

export const ReplyPackage = z
  .object({
    // Gmail's own ids for the message being answered and its thread.
    gmailMessageId: z.string().regex(/^[0-9a-f]{8,32}$/),
    threadId: z.string().regex(/^[0-9a-f]{8,32}$/),
    envelope: ReplyEnvelope,
    // The checked draft's sentences (replyText in packages/profile).
    body: z
      .string()
      .min(1)
      .max(5_000)
      .refine((s) => !/[\p{Cc}\p{Cf}]/u.test(s.replaceAll("\n", ""))),
    // The story and atom ids the draft's sentences cite, for the approval view.
    cites: z.array(z.string().min(1).max(64)).max(50),
    // The drafter's questions for Paul (ReplyDraft.followUps).
    followUps: z.array(z.string().min(1).max(200)).max(2),
  })
  .strict();
export type ReplyPackage = z.infer<typeof ReplyPackage>;

export type InvalidReply = { kind: "InvalidReply"; fields: string[] };

// Checks a package; the error names the bad fields, never their values.
export function parseReplyPackage(input: unknown): Result<ReplyPackage, InvalidReply> {
  const parsed = ReplyPackage.safeParse(input);
  if (parsed.success) return ok(parsed.data);
  const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))];
  return err({ kind: "InvalidReply", fields });
}

// The incoming message's headers, as the mail client read them.
export type InboundHeaders = {
  from: string | null;
  replyTo: string | null;
  subject: string | null;
  messageId: string | null;
  references: string | null;
};

// The single plain address in a header (`Name <a@b.example>` or `a@b.example`), or null for none,
// several, or anything else.
function singleAddress(header: string | null): string | null {
  if (header === null || CONTROL.test(header)) return null;
  const trimmed = header.trim();
  const angled = trimmed.match(/<([^<>]*)>/g);
  const candidate =
    angled === null ? trimmed : angled.length === 1 ? (angled[0] ?? "").slice(1, -1) : "";
  // A comma or a second @ means more than one address.
  if (candidate.includes(",") || candidate.split("@").length !== 2) return null;
  return ADDRESS.test(candidate) && candidate.length <= 254 ? candidate : null;
}

// The reply's envelope from the incoming headers alone (RPL-002): Reply-To, else From; "Re: " and
// the subject; In-Reply-To and References from the thread. A refusal names fields only.
export function replyEnvelope(inbound: InboundHeaders): Result<ReplyEnvelope, InvalidReply> {
  const bad: string[] = [];
  // A Reply-To that isn't one plain address is refused, not skipped for From: a reply shouldn't
  // quietly go to someone the sender didn't ask for.
  const to =
    inbound.replyTo !== null ? singleAddress(inbound.replyTo) : singleAddress(inbound.from);
  if (to === null) bad.push(inbound.replyTo !== null ? "replyTo" : "from");
  const original = inbound.subject?.trim() ?? "";
  const subject = /^re:/i.test(original) ? original : `Re: ${original}`.trim();
  if (original === "" || CONTROL.test(original) || subject.length > MAX_SUBJECT)
    bad.push("subject");
  const messageId = inbound.messageId?.trim() ?? "";
  if (!MESSAGE_ID.test(messageId)) bad.push("messageId");
  const earlier = (inbound.references ?? "").split(/\s+/).filter((r) => r !== "");
  if (earlier.some((r) => !MESSAGE_ID.test(r))) bad.push("references");
  if (bad.length > 0 || to === null) return err({ kind: "InvalidReply", fields: bad });
  const references = [...earlier.filter((r) => r !== messageId), messageId].slice(-MAX_REFERENCES);
  return ok({ to, subject, inReplyTo: messageId, references });
}

// What Paul approves: the recipient, subject, thread headers and body, in a fixed order.
export function replyContentSha256(pkg: ReplyPackage): string {
  const { to, subject, inReplyTo, references } = pkg.envelope;
  return createHash("sha256")
    .update(JSON.stringify([to, subject, inReplyTo, references, pkg.body]))
    .digest("hex");
}

// One message has one live reply (ADR-0017 item 6). The Gate's subjects name a UUID, so the
// Gmail id becomes a version 8 UUID from its hash: the same message always gives the same subject.
export function replySubject(gmailMessageId: string): string {
  const hex = createHash("sha256").update(`email_reply:${gmailMessageId}`).digest("hex").split("");
  hex[12] = "8";
  // RFC 9562 variant: the top two bits of this digit are 10.
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const h = hex.slice(0, 32).join("");
  return `email_reply:${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
