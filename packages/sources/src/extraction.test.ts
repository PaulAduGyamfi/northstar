import { describe, expect, it } from "vitest";
import { htmlToText } from "./extraction.js";

// htmlToText (NS-289, #484): one forward pass over an untrusted page, with the same output as the
// earlier regex chain on well-formed pages. Synthetic pages only.

// The earlier implementation, kept here only as the reference the new one must match.
function regexHtmlToText(html: string): string {
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    "#39": "'",
  };
  const decoded = html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|ul|ol|tr|section)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, name: string) => {
      const lower = name.toLowerCase();
      if (lower.startsWith("#")) {
        const code = lower.startsWith("#x")
          ? Number.parseInt(lower.slice(2), 16)
          : Number(lower.slice(1));
        const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
        return valid ? String.fromCodePoint(code) : m;
      }
      return entities[lower] ?? m;
    });
  return decoded
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const WELL_FORMED = [
  "<p>Build payment APIs &amp; services.</p>",
  "<ul><li>8+ years building distributed systems</li><li>Go</li></ul>",
  '<div class="job"><h2>Backend Engineer</h2><p>Remote, US.<br/>Full time.</p></div>',
  "<html><head><title>Acme</title><style>p { color: red }</style>" +
    "<script>var a = '<p>x</p>';</script></head><body><p>Acme builds tools.</p></body></html>",
  "<noscript>Turn on JavaScript.</noscript><SECTION><H1>Jobs</H1><P>One.</P></SECTION>",
  '<table><tr><td>Salary</td><td>$150k&ndash;$180k</td></tr></table><br class="x">Next',
  "Plain text with no tags & a lone ampersand, 3 < 5 and 7 > 2.",
  '<ol><li class="a">First</li><li>Second &#8212; &#x2019;</li></ol>',
];

describe("htmlToText", () => {
  it("gives the same text as the earlier regex chain on well-formed pages", () => {
    expect(WELL_FORMED.map(htmlToText)).toEqual(WELL_FORMED.map(regexHtmlToText));
  });

  it("never shows a script's, style's or noscript's content, whatever its case", () => {
    const text = htmlToText(
      "<p>Shown.</p><SCRIPT>hidden()</SCRIPT><style>.hidden{}</style><noscript>hidden</noscript>",
    );
    expect([text.includes("hidden"), text]).toEqual([false, "Shown."]);
  });

  it("reads a page of 200,000 unclosed script tags in one pass", () => {
    const html = `<p>Acme.</p>${"<script>".repeat(200_000)}`;
    const started = performance.now();
    htmlToText(html);
    // Linear: the regex chain took minutes on this page.
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("reads a page of 500,000 lone < signs in one pass, keeping them as text", () => {
    const html = `Acme ${"<".repeat(500_000)}`;
    const started = performance.now();
    const text = htmlToText(html);
    expect([performance.now() - started < 1_000, text.length]).toEqual([true, 500_005]);
  });

  it("reads a page of 200,000 unclosed <li tags in one pass", () => {
    const html = `<p>Acme.</p>${"<li".repeat(200_000)}`;
    const started = performance.now();
    htmlToText(html);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
