import { decodeEntities, htmlToText } from "../extraction.js";

// Rules for untrusted text from permissive feeds (NS-282): an HN comment, an RSS item. Anyone can
// write it, so it is cleaned before it is stored, and a name is only taken where it is plain.

// Bounds on what one item can put in a job: a stored field never grows past these.
export const MAX_FIELD = 200;
export const MAX_DESCRIPTION = 20_000;

// Control, formatting and blank-looking characters (bidi overrides, zero-width joiners, Hangul
// fillers, the braille blank, variation selectors): they would let an item reorder or hide text
// where its company or title is shown. Newlines and tabs stay.
const INVISIBLE =
  /(?![\n\t])[\p{Cc}\p{Cf}\u2028\u2029\u115F\u1160\u3164\uFFA0\u2800]|\u034F|[\uFE00-\uFE0F]/gu;

export const stripInvisible = (text: string) => text.replace(INVISIBLE, "");

// HTML (or text with entities) to plain, cleaned text: its HTML entities decoded, tags dropped,
// invisible characters stripped after that decode.
export const cleanHtml = (html: string) => stripInvisible(htmlToText(html));

// A one-line text field (a title): HTML entities decoded, any tags dropped, invisible characters
// stripped after that decode, whitespace folded.
export const cleanLine = (text: string) =>
  stripInvisible(decodeEntities(text.replace(/<[^>]*>/g, " ")))
    .replace(/\s+/g, " ")
    .trim();

// Words that name a role, so the field holding one is the title.
export const ROLE =
  /\b(engineer|engineering|developer|programmer|designer|scientist|architect|manager|lead|director|analyst|researcher|sre|devops|founding|intern|head of|vp|cto|recruiter|product|marketer|writer|specialist|administrator|technician|consultant)s?\b/i;

// A field fit to store as a name or place: short, and not a link or address.
export const usable = (s: string) => s.length <= MAX_FIELD && !/(https?:\/\/|www\.|@)/i.test(s);
