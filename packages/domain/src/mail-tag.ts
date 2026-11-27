import { randomInt } from "node:crypto";

// Plus-address tags (VER-007), the same rules as packages/inbox's link/tag.ts (NS-158). The
// package caller and the Gate need them, and neither depends on packages/inbox; a parity test in
// packages/funnel, which depends on both, keeps the two copies the same (NS-248).

// RFC 4648 base32, lower case: no 0/1/8/9, so a tag survives being read aloud or retyped.
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const MAIL_TAG_LENGTH = 6;
export const MAIL_TAG_PATTERN = new RegExp(`^[${ALPHABET}]{${MAIL_TAG_LENGTH}}$`);

// 6 characters from a cryptographic RNG, never derived from the company, role or anything else
// guessable.
export function generateMailTag(): string {
  let tag = "";
  for (let i = 0; i < MAIL_TAG_LENGTH; i++) tag += ALPHABET.charAt(randomInt(ALPHABET.length));
  return tag;
}

// Whether a tag can go on this address: a plain address with no `+` part, so tags never stack.
export function isTaggableAddress(base: string): boolean {
  const at = base.lastIndexOf("@");
  const local = base.slice(0, at);
  const domain = base.slice(at + 1);
  return at > 0 && domain !== "" && !local.includes("+") && !/[\s<>"@]/.test(local + domain);
}

// `<local>+ns-<tag>@<domain>`. Throws on a tag that isn't one or a base that isn't taggable.
export function taggedAddress(base: string, tag: string): string {
  if (!MAIL_TAG_PATTERN.test(tag)) throw new Error("not a mail tag");
  if (!isTaggableAddress(base)) throw new Error("not a plain email address");
  const at = base.lastIndexOf("@");
  return `${base.slice(0, at)}+ns-${tag}@${base.slice(at + 1)}`;
}
