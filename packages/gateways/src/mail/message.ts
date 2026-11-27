import { ReplyEnvelope } from "@northstar/domain";
import { DraftInputError } from "./errors.js";

// The header that marks a draft as made for one approval (ADR-0025 item 5): after an unknown
// outcome the writer looks for it in the thread before it creates another draft.
export const APPROVAL_HEADER = "X-Northstar-Approval";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The approved fields a draft is built from, and nothing else.
export type DraftContent = {
  envelope: ReplyEnvelope;
  body: string;
  decisionId: string;
};

// Folds a header's parts onto continuation lines (CRLF and a space), so no line passes RFC 5322's
// 998 characters however long the References chain is.
const FOLD = "\r\n ";

// A header value: ASCII as it is, anything else as RFC 2047 encoded words (UTF-8, base64), each
// at most 75 characters: whole characters of up to 45 bytes per word, folded onto their own lines.
function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const words: string[] = [];
  let chunk = "";
  for (const ch of value) {
    if (Buffer.byteLength(chunk + ch, "utf8") > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk !== "") words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join(FOLD);
}

// The draft as an RFC 5322 message, base64url for Gmail's `raw` (NS-237 slice 4). Every header comes
// from the approved envelope, checked again with its schema here, so a line break or control
// character can't add a header. The body goes in base64, so its own lines can't either.
export function buildDraftMessage(content: DraftContent): string {
  const envelope = ReplyEnvelope.safeParse(content.envelope);
  if (!envelope.success) throw new DraftInputError("envelope");
  if (!UUID.test(content.decisionId)) throw new DraftInputError("decisionId");
  if (content.body.length === 0) throw new DraftInputError("body");
  const { to, subject, inReplyTo, references } = envelope.data;
  // Lines of 76 base64 characters, as MIME asks.
  const body = (
    Buffer.from(content.body, "utf8")
      .toString("base64")
      .match(/.{1,76}/g) ?? []
  ).join("\r\n");
  const lines = [
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `In-Reply-To: ${inReplyTo}`,
    `References: ${references.join(FOLD)}`,
    `${APPROVAL_HEADER}: ${content.decisionId}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}
