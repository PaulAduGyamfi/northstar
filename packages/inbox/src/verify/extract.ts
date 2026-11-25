// Deterministic extraction of verification codes and links (VER-003). Plain code, no model: the
// email is untrusted text, and a wrong guess here would type a stranger's code or open a
// stranger's link. It returns every distinct candidate; the catcher decides what "one" means.

export type Extracted = { codes: string[]; links: string[] };

// A line that says it carries a code. "verify" is here too: "Enter this to verify: 4821".
const CODE_WORDS = /\b(codes?|verification|verify|one[- ]time|passcode|pin|otp)\b/i;

// Words in a link's path, query, fragment or anchor text that mean "this verifies you".
const LINK_WORDS = /verif|confirm|activat|validat|sign[-_ ]?in|log[-_ ]?in|magic|reset/i;

const URL_IN_TEXT = /https?:\/\/[^\s<>"'()[\]]+/gi;

// A code is 4 to 8 characters: digits only, or capitals and digits with at least one digit (so
// words like "CODE" or "OTP" never count).
function isCode(token: string): boolean {
  if (/^[0-9]{4,8}$/.test(token)) return true;
  return /^[A-Z0-9]{4,8}$/.test(token) && /[0-9]/.test(token) && /[A-Z]/.test(token);
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const hex = name[1] === "x" || name[1] === "X";
      const n = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
      // An out-of-range number would make fromCodePoint throw; keep the text as it was.
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

// HTML to plain lines: scripts and styles dropped, a line break at each block, tags removed,
// entities decoded, blank lines dropped. Good enough to find a code; never rendered anywhere.
export function htmlToText(html: string): string {
  const text = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(
      /<(br|\/?(p|div|tr|td|th|li|h[1-6]|table|section|article|header|footer))\b[^>]*>/gi,
      "\n",
    )
    .replace(/<[^>]*>/g, "");
  return decodeEntities(text)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "")
    .join("\n");
}

function codesIn(lines: readonly string[]): string[] {
  const out: string[] = [];
  lines.forEach((raw, i) => {
    if (!CODE_WORDS.test(raw)) return;
    // Links on the line can hold digit runs (ids, tokens) that aren't the code.
    const line = raw.replace(URL_IN_TEXT, " ");
    out.push(...line.split(/[^A-Za-z0-9]+/).filter(isCode));
    // The code often sits alone on the next non-blank line. Only a line that is nothing but the
    // code counts, so an address or a footer below "Your code is below" never does.
    const next = lines.slice(i + 1).find((l) => l.trim() !== "");
    if (next !== undefined && isCode(next.trim())) out.push(next.trim());
  });
  return out;
}

function linksInHtml(html: string): string[] {
  const out: string[] = [];
  const anchor = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi;
  for (const m of html.matchAll(anchor)) {
    const href = decodeEntities((m[1] ?? m[2] ?? "").trim());
    if (!/^https?:\/\//i.test(href)) continue;
    const label = htmlToText(m[3] ?? "");
    if (LINK_WORDS.test(afterHost(href)) || LINK_WORDS.test(label)) out.push(href);
  }
  return out;
}

function linksInText(text: string): string[] {
  return [...text.matchAll(URL_IN_TEXT)]
    .map((m) => m[0].replace(/[.,;:!?]+$/, ""))
    .filter((url) => LINK_WORDS.test(afterHost(url)));
}

// The part of a URL after its host, so a host name like "verify.example.com" alone doesn't count.
function afterHost(url: string): string {
  return url.replace(/^https?:\/\/[^/?#]*/i, "");
}

const distinct = (xs: readonly string[]) => [...new Set(xs)];

export function extractVerification(text: string, html: string | null): Extracted {
  const htmlLines = html ? htmlToText(html).split("\n") : [];
  return {
    codes: distinct([...codesIn(text.split("\n")), ...codesIn(htmlLines)]),
    links: distinct([...linksInText(text), ...(html ? linksInHtml(html) : [])]),
  };
}
