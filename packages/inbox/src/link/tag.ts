import { randomInt } from "node:crypto";

// Plus-address tags (NS-158, VER-007). Each application, or each tenant where an account is
// needed, gets a short random tag; Northstar applies with `<local>+ns-<tag>@<domain>` and Gmail
// delivers it to the normal inbox with `Delivered-To` naming the tagged address. The tag routes
// mail; it never proves who sent it (INB-011).

// RFC 4648 base32, lower case: no 0/1/8/9, so a tag survives being read aloud or retyped.
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
export const TAG_LENGTH = 6;
export const TAG_PATTERN = new RegExp(`^[${ALPHABET}]{${TAG_LENGTH}}$`);

// 6 characters from a cryptographic RNG: 2^30 tags, never derived from the company, role or
// anything else guessable.
export function generateTag(): string {
  let tag = "";
  for (let i = 0; i < TAG_LENGTH; i++) tag += ALPHABET.charAt(randomInt(ALPHABET.length));
  return tag;
}

// `<local>+ns-<tag>@<domain>` from the base address. Refuses a base that already has a `+`
// part or isn't a plain address, so a tag never stacks on another one.
export function taggedAddress(base: string, tag: string): string {
  if (!TAG_PATTERN.test(tag)) throw new Error("not a mail tag");
  const at = base.lastIndexOf("@");
  const local = base.slice(0, at);
  const domain = base.slice(at + 1);
  if (at <= 0 || domain === "" || local.includes("+") || /[\s<>"@]/.test(local + domain)) {
    throw new Error("not a plain email address");
  }
  return `${local}+ns-${tag}@${domain}`;
}

// What the Delivered-To header says about a tag: none (no `+ns-` part), a well-formed tag, or a
// `+ns-` part that isn't one (which matching treats like an unknown tag, never a guess). Read
// only from Delivered-To, which Gmail adds, never To or Cc, which the sender writes (INB-011).
export type DeliveredTag = { kind: "none" } | { kind: "tag"; tag: string } | { kind: "malformed" };

export function tagFromDeliveredTo(deliveredTo: string | null): DeliveredTag {
  if (deliveredTo === null) return { kind: "none" };
  // The address may come bare or as `Name <addr>`; take the address part.
  const address = (deliveredTo.match(/<([^>]*)>/)?.[1] ?? deliveredTo).trim().toLowerCase();
  const local = address.slice(0, address.lastIndexOf("@"));
  const plus = local.indexOf("+ns-");
  if (plus < 0) return { kind: "none" };
  const tag = local.slice(plus + "+ns-".length);
  return TAG_PATTERN.test(tag) ? { kind: "tag", tag } : { kind: "malformed" };
}
