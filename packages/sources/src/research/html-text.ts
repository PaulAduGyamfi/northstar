// A company page's visible text (NS-283 site slice), plain code with no parser dependency. The
// page is untrusted: this only turns it into text to quote from, never runs or follows anything in
// it. It walks the HTML once with indexOf jumps (no backtracking regex over the page), so a hostile
// page of 2 MB costs one pass: script, style and other non-text elements are dropped whole, block
// elements become line breaks, inline ones join their words, and a few entities are decoded.
// Not `extraction.ts`'s `htmlToText`: its lazy `<script>…</script>` pattern rescans the rest of
// the page for every unclosed script tag, which a company site (any page on the web) could abuse.

// The most text kept from one page; a page past it is cut at a line break.
export const MAX_SITE_TEXT = 50_000;

// Elements whose content is never visible text. Their whole content is skipped, so nothing in a
// script or a style sheet can reach a quote.
const SKIPPED = new Set([
  "head",
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "object",
  "canvas",
  "select",
  "textarea",
]);

// Elements that end a line of text: a sentence never runs across two of them.
const BLOCKS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "section",
  "table",
  "td",
  "th",
  "tr",
  "ul",
]);

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
};

// The tag name at `<` (or `</`), lower-cased ASCII, or "" when it isn't a tag.
function tagName(html: string, at: number): { name: string; closing: boolean } {
  let i = at + 1;
  const closing = html[i] === "/";
  if (closing) i++;
  let name = "";
  while (i < html.length && name.length < 20) {
    const c = html.charCodeAt(i);
    const letter = (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57);
    if (!letter) break;
    name += String.fromCharCode(c >= 65 && c <= 90 ? c + 32 : c);
    i++;
  }
  return { name, closing };
}

// Where the closing tag of a skipped element ends, searching from `from`; the page's end if it has
// none. Each search moves forward from where the last one started, so the walk stays linear.
function endOfElement(html: string, name: string, from: number): number {
  let i = from;
  for (;;) {
    const open = html.indexOf("</", i);
    if (open < 0) return html.length;
    const tag = tagName(html, open);
    if (tag.closing && tag.name === name) {
      const close = html.indexOf(">", open);
      return close < 0 ? html.length : close + 1;
    }
    i = open + 2;
  }
}

// Decodes the named entities above and numeric ones that are real characters; leaves any other
// "&…;" as written. The pattern has bounded parts, so it can't backtrack badly.
function decodeEntities(text: string): string {
  return text.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/g, (whole, body) => {
    if (body[0] !== "#") return NAMED[body.toLowerCase()] ?? whole;
    const code =
      body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
    const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
    return valid ? String.fromCodePoint(code) : whole;
  });
}

export function htmlText(html: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const gt = html.indexOf(">", lt);
    // An unclosed tag at the end: nothing after it is text.
    if (gt < 0) break;
    const tag = tagName(html, lt);
    if (tag.name === "") {
      // "<" not starting a tag (a doctype, "<!", "< 3") is dropped with what follows up to ">".
      i = gt + 1;
      continue;
    }
    if (!tag.closing && SKIPPED.has(tag.name)) {
      // A self-closing skipped element ("<svg/>") has no content to skip.
      i = html[gt - 1] === "/" ? gt + 1 : endOfElement(html, tag.name, gt + 1);
      out.push("\n");
      continue;
    }
    if (BLOCKS.has(tag.name)) out.push("\n");
    i = gt + 1;
  }
  const lines = decodeEntities(out.join(""))
    .split("\n")
    .map((l) => l.replace(/[ \t\r\f\v ]+/g, " ").trim())
    .filter((l) => l !== "");
  let text = lines.join("\n");
  if (text.length > MAX_SITE_TEXT) {
    const cut = text.lastIndexOf("\n", MAX_SITE_TEXT);
    text = text.slice(0, cut > 0 ? cut : MAX_SITE_TEXT);
  }
  return text;
}
