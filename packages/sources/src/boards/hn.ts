import { z } from "zod";
import { type Extraction, emptyFields, htmlToText, remoteFrom } from "../extraction.js";
import { type BoardPosting, BoardUnavailable, MAX_POSTINGS } from "./list.js";

// The monthly Hacker News "Ask HN: Who is hiring?" thread (NS-282 slice 1), read through HN's
// public Algolia search API (hn.algolia.com, documented, no login): one request finds the newest
// thread by the `whoishiring` account, one reads it with its comments. Each top-level comment is
// one posting. Its text is untrusted: plain code reads only HN's own first-line convention
// (`Company | Role | Location | …`), and anything that doesn't follow it is kept as a draft.

export type ReadJson = <T>(url: string, shape: z.ZodType<T>) => Promise<T>;

const ALGOLIA = "https://hn.algolia.com/api/v1";
// The thread's title as the whoishiring account posts it each month.
const THREAD_TITLE = /^Ask HN: Who is hiring\? \(/;
// HN item ids are plain numbers.
const ITEM_ID = /^\d{1,12}$/;
// Bounds on what a comment can put in a job: a stored field never grows past these.
const MAX_FIELD = 200;
const MAX_DESCRIPTION = 20_000;

const Search = z.object({
  hits: z.array(
    z.object({
      objectID: z.string().regex(ITEM_ID),
      title: z.string().nullable().optional(),
      created_at_i: z.number(),
    }),
  ),
});

type Comment = {
  id: number;
  author?: string | null;
  text?: string | null;
  created_at_i?: number | null;
  type?: string;
};
const CommentShape: z.ZodType<Comment> = z.object({
  id: z.number().int().positive(),
  author: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
  created_at_i: z.number().nullable().optional(),
  type: z.string().optional(),
});
const Thread = z.object({
  id: z.number().int().positive(),
  children: z.array(z.unknown()),
});

export async function listHnHiring(read: ReadJson): Promise<BoardPosting[]> {
  const search = await read(
    `${ALGOLIA}/search_by_date?tags=story,author_whoishiring&hitsPerPage=20`,
    Search,
  );
  // The newest "Who is hiring?" story; the account also posts "Who wants to be hired?" and
  // "Freelancer?" threads, which are not job postings.
  const thread = search.hits
    .filter((h) => THREAD_TITLE.test(h.title ?? ""))
    .sort((a, b) => b.created_at_i - a.created_at_i)[0];
  if (thread === undefined) throw new BoardUnavailable("no Who is hiring? thread was found");
  const item = await read(`${ALGOLIA}/items/${thread.objectID}`, Thread);
  // Top-level comments only: replies are conversation, not postings.
  return item.children.slice(0, MAX_POSTINGS).flatMap((child) => {
    const parsed = CommentShape.safeParse(child);
    if (!parsed.success) return [];
    const posting = postingFrom(parsed.data);
    return posting === null ? [] : [posting];
  });
}

// One comment as a posting, or null for a deleted or dead comment (no author or no text).
export function postingFrom(c: Comment): BoardPosting | null {
  if (!c.author || !c.text || (c.type !== undefined && c.type !== "comment")) return null;
  const text = commentText(c.text);
  if (text === "") return null;
  const head = firstLine(text);
  const fields = emptyFields();
  const read = readHead(head);
  fields.company = read.company;
  fields.title = read.title;
  fields.location = read.location;
  fields.remote = remoteFrom(head);
  fields.description = text.slice(0, MAX_DESCRIPTION);
  fields.postedAt = postedAt(c.created_at_i);
  const extraction: Extraction = { fields, method: "text", ats: null, atsPostingId: null };
  return { url: `https://news.ycombinator.com/item?id=${c.id}`, extraction };
}

// HN writes paragraphs as bare `<p>` with no closing tag: each starts a new line.
function commentText(html: string): string {
  return htmlToText(html.replace(/<p>/gi, "\n\n")).replace(INVISIBLE, "");
}

// Control, formatting and blank-looking characters (bidi overrides, zero-width joiners, Hangul
// fillers, the braille blank, variation selectors): anyone can post on HN, and these would let a
// comment reorder or hide text where its company or title is shown. Newlines and tabs stay.
const INVISIBLE =
  /(?![\n\t])[\p{Cc}\p{Cf}\u2028\u2029\u115F\u1160\u3164\uFFA0\u2800\u034F\uFE00-\uFE0F]/gu;

// HN's own time for the comment, in seconds; anything outside 2007 to 2100 is no date.
function postedAt(seconds: number | null | undefined): Date | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  if (seconds < 1_170_000_000 || seconds > 4_102_444_800) return null;
  return new Date(seconds * 1000);
}

const firstLine = (text: string) => (text.split("\n")[0] ?? "").trim();

// Words that name a role, so the field holding one is the title.
const ROLE =
  /\b(engineer|engineering|developer|programmer|designer|scientist|architect|manager|lead|director|analyst|researcher|sre|devops|founding|intern|head of|vp|cto|recruiter|product|marketer|writer|specialist|administrator|technician|consultant)s?\b/i;
// Fields that are terms, pay or links rather than a place.
const NOT_PLACE =
  /(https?:\/\/|www\.|@|\$|€|£|\d+k\b|\bfull[- ]?time\b|\bpart[- ]?time\b|\bcontract\b|\bvisa\b|\bequity\b|\bsalary\b|\bintern(ship)?s?\b)/i;
const PURE_MODE = /^(remote|onsite|on-site|hybrid|in[- ]office)$/i;

// HN's convention: `Company | Role | Location | …` on the first line. Nothing is guessed: with
// fewer than two fields, or no field naming a role, title and company stay null (a draft).
export function readHead(head: string): {
  company: string | null;
  title: string | null;
  location: string | null;
} {
  const parts = head
    .split("|")
    // Already decoded once by htmlToText: a second decode would turn a commenter's literal
    // `&#x202E;` into the real character.
    .map((p) => p.trim())
    .filter((p) => p !== "");
  const none = { company: null, title: null, location: null };
  if (parts.length < 2) return none;
  const [company, ...rest] = parts;
  if (company === undefined || !usable(company) || ROLE.test(company)) return none;
  const titleIndex = rest.findIndex((p) => ROLE.test(p) && usable(p));
  if (titleIndex === -1) return none;
  const title = rest[titleIndex] ?? null;
  const others = rest.filter((_, i) => i !== titleIndex);
  // A place first (a city, or "Remote (EU)"); a bare work-mode word ("ONSITE") only when nothing
  // else names one, since remoteFrom already reads it into `remote`.
  const place = (p: string) => usable(p) && !NOT_PLACE.test(p) && /[a-z]/i.test(p);
  const location =
    others.find((p) => place(p) && !PURE_MODE.test(p)) ?? others.find((p) => place(p)) ?? null;
  return { company, title, location };
}

// A field fit to store: short, and not a link or address (a link is never a name).
const usable = (s: string) => s.length <= MAX_FIELD && !/(https?:\/\/|www\.|@)/i.test(s);
