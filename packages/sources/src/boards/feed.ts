import { XMLParser } from "fast-xml-parser";
import { decodeEntities, type Extraction, emptyFields, remoteFrom } from "../extraction.js";
import { BOARD_MAX_BYTES, canonicalUrl, type FetchDeps, safeFetch } from "../fetch.js";
import { termsFor } from "../terms.js";
import { cleanHtml, cleanLine, MAX_DESCRIPTION, ROLE, stripInvisible, usable } from "./text.js";
import { type BoardPosting, BoardUnavailable, MAX_POSTINGS } from "./types.js";

// An RSS 2.0, Atom or JSON Feed of job postings that Paul names by its URL (NS-282 slice 2). One
// request a poll. Every item is untrusted text: plain code reads its link, title, date and body,
// and an item whose title doesn't say both a role and a company stays a draft. No model reads it.

// A posting link: https, at most this long, and never on a site whose terms forbid automated
// reads (a feed that points at LinkedIn postings gives nothing).
const MAX_LINK = 2000;
// Feed dates before 2000, or more than 5 minutes after now, are no date: a future date would keep
// an item at the top of the freshness order and pass the fresh-job alert's age test (SRC-012).
const EARLIEST = Date.UTC(2000, 0, 1);
const CLOCK_SKEW_MS = 5 * 60_000;

type Item = { link: string | null; title: string; date: string; html: string; text: string };

export async function listFeed(deps: FetchDeps, board: string, now: Date): Promise<BoardPosting[]> {
  const res = await safeFetch(deps, board, { maxBytes: BOARD_MAX_BYTES });
  // safeFetch refuses a redirect onto a site whose terms forbid automated reads, on every hop.
  if (res.status !== 200) throw new BoardUnavailable(`the feed answered ${res.status}`);
  return parseFeed(res.body)
    .slice(0, MAX_POSTINGS)
    .flatMap((item) => {
      const posting = postingFrom(item, now);
      return posting === null ? [] : [posting];
    });
}

// The feed's items, whichever of the three formats it is. Anything else is unavailable.
export function parseFeed(body: string): Item[] {
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{")) return jsonFeed(trimmed);
  if (trimmed.startsWith("<")) return xmlFeed(trimmed);
  throw new BoardUnavailable("the feed isn't RSS, Atom or JSON Feed");
}

function jsonFeed(body: string): Item[] {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    throw new BoardUnavailable("the feed isn't valid JSON");
  }
  const feed = record(doc);
  if (
    !str(feed.version).startsWith("https://jsonfeed.org/version/1") ||
    !Array.isArray(feed.items)
  ) {
    throw new BoardUnavailable("the feed isn't a JSON Feed");
  }
  return feed.items.slice(0, MAX_POSTINGS).map((raw) => {
    const i = record(raw);
    return {
      link: str(i.url) || null,
      title: str(i.title),
      date: str(i.date_published),
      html: str(i.content_html) || str(i.summary),
      text: str(i.content_text),
    };
  });
}

// Entities are never expanded by the parser (`processEntities: false`), and a feed that declares a
// DOCTYPE is refused outright, so no entity a feed defines can grow it (billion laughs). The check
// runs on the whole body, so even a `<!DOCTYPE html>` inside an item's CDATA refuses the feed: the
// safe direction (the watch backs off). The XML layer is decoded in `text`, the HTML layer after.
const parser = new XMLParser({
  processEntities: false,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  cdataPropName: "__cdata",
  parseTagValue: false,
  parseAttributeValue: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  maxNestedTags: 64,
  // Always lists, so one item and many read the same way.
  isArray: (name) => name === "item" || name === "entry" || name === "link",
});

function xmlFeed(body: string): Item[] {
  if (/<!(DOCTYPE|ENTITY)/i.test(body)) throw new BoardUnavailable("the feed declares a DOCTYPE");
  let doc: Record<string, unknown>;
  try {
    doc = record(parser.parse(body));
  } catch {
    throw new BoardUnavailable("the feed isn't valid XML");
  }
  const rss = record(record(doc.rss).channel);
  if (Array.isArray(rss.item)) {
    return rss.item.slice(0, MAX_POSTINGS).map((raw) => {
      const i = record(raw);
      return {
        link: firstText(i.link) || null,
        title: text(i.title),
        date: text(i.pubDate),
        html: text(i["content:encoded"]) || text(i.description),
        text: "",
      };
    });
  }
  const atom = record(doc.feed);
  if (Array.isArray(atom.entry)) {
    return atom.entry.slice(0, MAX_POSTINGS).map((raw) => {
      const e = record(raw);
      return {
        link: atomLink(e.link),
        title: text(e.title),
        date: text(e.published) || text(e.updated),
        html: text(e.content) || text(e.summary),
        text: "",
      };
    });
  }
  throw new BoardUnavailable("the feed has no RSS items or Atom entries");
}

// Atom names the posting's page as the link with rel="alternate", or with no rel at all.
function atomLink(links: unknown): string | null {
  if (!Array.isArray(links)) return null;
  const page = links.map(record).find((l) => {
    const rel = str(l["@_rel"]);
    return rel === "" || rel === "alternate";
  });
  return page === undefined ? null : decodeEntities(str(page["@_href"])) || null;
}

// An element's text with its XML layer decoded (the five entities and numeric references); CDATA
// is already literal. The HTML layer is decoded later by cleanLine or cleanHtml, and invisible
// characters are stripped only after that last decode, so neither layer can smuggle one in.
function text(node: unknown): string {
  if (typeof node === "string") return decodeEntities(node);
  const r = record(node);
  if (typeof r.__cdata === "string") return r.__cdata;
  if (Array.isArray(r.__cdata)) return r.__cdata.filter((c) => typeof c === "string").join("");
  if (typeof r["#text"] === "string") return decodeEntities(r["#text"]);
  return "";
}

const firstText = (nodes: unknown) => (Array.isArray(nodes) ? text(nodes[0]) : text(nodes));

// One item as a posting, or null when it has no usable link.
export function postingFrom(item: Item, now: Date): BoardPosting | null {
  const url = postingUrl(item.link);
  if (url === null) return null;
  const title = cleanLine(item.title);
  const fields = emptyFields();
  const read = readTitle(title);
  fields.title = read.title;
  fields.company = read.company;
  fields.remote = remoteFrom(title);
  // JSON Feed's content_text is plain text: only invisible characters are removed.
  const description = item.html !== "" ? cleanHtml(item.html) : stripInvisible(item.text).trim();
  fields.description = description === "" ? null : description.slice(0, MAX_DESCRIPTION);
  fields.postedAt = postedAt(item.date, now);
  const extraction: Extraction = { fields, method: "text", ats: null, atsPostingId: null };
  return { url, extraction };
}

function postingUrl(raw: string | null): string | null {
  if (raw === null) return null;
  const link = raw.trim();
  if (link.length > MAX_LINK) return null;
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const url = canonicalUrl(u.toString());
  return termsFor(url).terms === "prohibited" ? null : url;
}

function postedAt(raw: string, now: Date): Date | null {
  const ms = Date.parse(raw.trim());
  if (!Number.isFinite(ms) || ms < EARLIEST || ms > now.getTime() + CLOCK_SKEW_MS) return null;
  return new Date(ms);
}

// The two ways job feeds title an item: "Senior Engineer at Globex" and "Globex: Senior Engineer".
// Exactly one form must fit: a title both fit ("Globex: Engineer at Night") is ambiguous, and
// anything else keeps the title only when it names a role, with no company (a draft).
export function readTitle(title: string): { title: string | null; company: string | null } {
  const role = (s: string) => s !== "" && ROLE.test(s) && usable(s);
  const company = (s: string) => s !== "" && usable(s) && !ROLE.test(s);
  const draft = { title: role(title) ? title : null, company: null };
  const fits: { title: string; company: string }[] = [];
  const at = title.lastIndexOf(" at ");
  if (at > 0) {
    const [t, c] = [title.slice(0, at).trim(), title.slice(at + 4).trim()];
    if (role(t) && company(c)) fits.push({ title: t, company: c });
  }
  const colon = title.indexOf(": ");
  if (colon > 0) {
    const [c, t] = [title.slice(0, colon).trim(), title.slice(colon + 2).trim()];
    if (role(t) && company(c)) fits.push({ title: t, company: c });
  }
  return fits.length === 1 && fits[0] !== undefined ? fits[0] : draft;
}

const record = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string => (typeof v === "string" ? v : "");
