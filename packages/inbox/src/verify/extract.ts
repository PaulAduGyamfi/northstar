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
  // Bounded lengths keep this linear on hostile input like "&aaaa…".
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{1,10});/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const hex = name[1] === "x" || name[1] === "X";
      const n = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
      // An out-of-range number would make fromCodePoint throw; keep the text as it was.
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

// Tags that start a new line of text.
const BLOCK_TAGS = new Set([
  "br",
  "p",
  "div",
  "tr",
  "td",
  "th",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
  "section",
  "article",
  "header",
  "footer",
]);

const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const MAX_LABEL = 500; // anchor text past this is never a "Verify" button

type Scanned = { text: string; anchors: { href: string; label: string }[] };

// One left-to-right pass over the HTML: text outside tags (a line break at each block tag),
// script and style contents dropped, and each <a href>'s target and text. Hand-written rather
// than regexes over the whole body, so hostile HTML (thousands of "<" or an unclosed tag) costs
// linear time: every step moves forward, and an unclosed tag or script ends the scan.
function scanHtml(html: string): Scanned {
  const lowerHtml = html.toLowerCase();
  const out: string[] = [];
  const anchors: Scanned["anchors"] = [];
  let open: { href: string; from: number } | null = null;
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) break;
    const tag = html.slice(lt + 1, gt);
    const closing = tag.startsWith("/");
    const name = /^\/?\s*([a-z0-9]+)/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    i = gt + 1;
    if (!closing && (name === "script" || name === "style")) {
      const end = lowerHtml.indexOf(`</${name}`, i);
      const endGt = end === -1 ? -1 : html.indexOf(">", end);
      if (endGt === -1) break;
      i = endGt + 1;
      continue;
    }
    if (BLOCK_TAGS.has(name)) out.push("\n");
    if (name === "a" && !closing) {
      const m = HREF.exec(tag);
      open = { href: decodeEntities((m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim()), from: out.length };
    } else if (name === "a" && open) {
      const label = out.slice(open.from).join("").slice(0, MAX_LABEL);
      anchors.push({ href: open.href, label: decodeEntities(label) });
      open = null;
    }
  }
  return { text: out.join(""), anchors };
}

// HTML to plain lines: scripts and styles dropped, a line break at each block, tags removed,
// entities decoded, blank lines dropped. Good enough to find a code; never rendered anywhere.
export function htmlToText(html: string): string {
  return toLines(decodeEntities(scanHtml(html).text)).join("\n");
}

function toLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "");
}

function codesIn(lines: readonly string[]): string[] {
  // nextFilled[i] is the first non-blank line after line i, found in one backward pass.
  const nextFilled: (string | undefined)[] = new Array(lines.length);
  let filled: string | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    nextFilled[i] = filled;
    const t = (lines[i] as string).trim();
    if (t !== "") filled = t;
  }
  const out: string[] = [];
  lines.forEach((raw, i) => {
    if (!CODE_WORDS.test(raw)) return;
    // Links on the line can hold digit runs (ids, tokens) that aren't the code.
    const line = raw.replace(URL_IN_TEXT, " ");
    out.push(...line.split(/[^A-Za-z0-9]+/).filter(isCode));
    // The code often sits alone on the next non-blank line. Only a line that is nothing but the
    // code counts, so an address or a footer below "Your code is below" never does.
    const next = nextFilled[i];
    if (next !== undefined && isCode(next)) out.push(next);
  });
  return out;
}

function linksInAnchors(anchors: Scanned["anchors"]): string[] {
  return anchors
    .filter(({ href }) => /^https?:\/\//i.test(href))
    .filter(({ href, label }) => LINK_WORDS.test(afterHost(href)) || LINK_WORDS.test(label))
    .map(({ href }) => href);
}

// Sentence punctuation right after a URL in text isn't part of it. A loop, not /[.,]+$/, which
// backtracks quadratically on a long run of dots.
function trimTrailingPunctuation(url: string): string {
  let end = url.length;
  while (end > 0 && ".,;:!?".includes(url[end - 1] as string)) end--;
  return url.slice(0, end);
}

function linksInText(text: string): string[] {
  return [...text.matchAll(URL_IN_TEXT)]
    .map((m) => trimTrailingPunctuation(m[0]))
    .filter((url) => LINK_WORDS.test(afterHost(url)));
}

// The part of a URL after its host, so a host name like "verify.example.com" alone doesn't count.
function afterHost(url: string): string {
  return url.replace(/^https?:\/\/[^/?#]*/i, "");
}

const distinct = (xs: readonly string[]) => [...new Set(xs)];

export function extractVerification(text: string, html: string | null): Extracted {
  const scanned = html ? scanHtml(html) : { text: "", anchors: [] };
  const htmlLines = toLines(decodeEntities(scanned.text));
  return {
    codes: distinct([...codesIn(text.split("\n")), ...codesIn(htmlLines)]),
    links: distinct([...linksInText(text), ...linksInAnchors(scanned.anchors)]),
  };
}
