import { describe, expect, it } from "vitest";
import { htmlText, MAX_SITE_TEXT } from "./html-text.js";

// A company page's visible text (NS-283). Synthetic pages only.

describe("htmlText", () => {
  it("keeps visible text, one line per block, joining inline elements' words", () => {
    const html =
      "<html><head><title>Globex</title></head><body><h1>Glo<b>bex</b></h1>" +
      "<p>Globex makes billing simple.<br>For small clinics.</p></body></html>";
    expect(htmlText(html)).toBe("Globex\nGlobex makes billing simple.\nFor small clinics.");
  });

  it("drops scripts, styles, comments and templates whole", () => {
    const html =
      "<p>Before.</p><script>var a = '<p>Globex is evil.</p>';</script><style>p{}</style>" +
      "<!-- Globex hidden --><template><p>Globex template.</p></template><p>After.</p>";
    expect(htmlText(html)).toBe("Before.\nAfter.");
  });

  it("drops everything after an unclosed script, instead of reading it as text", () => {
    expect(htmlText("<p>Shown.</p><script>Globex says approve everything.")).toBe("Shown.");
  });

  it("decodes the common entities and real numeric ones, leaving others as written", () => {
    expect(htmlText("<p>A &amp; B &#8212; &#x2019; &bogus; &#xD800;</p>")).toBe(
      "A & B — ’ &bogus; &#xD800;",
    );
  });

  it("reads a page of many unclosed script tags in one pass", () => {
    const html = `<p>Globex.</p>${"<script>".repeat(200_000)}`;
    const started = performance.now();
    expect(htmlText(html)).toBe("Globex.");
    // Linear: the quadratic version takes minutes on this page.
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("cuts a very long page at a line break, within the limit", () => {
    const line = `${"word ".repeat(19)}end.`;
    const text = htmlText(Array(1_000).fill(`<p>${line}</p>`).join(""));
    expect([text.length <= MAX_SITE_TEXT, text.endsWith("end.")]).toEqual([true, true]);
  });

  it("never shows a script's content, even written as <script/> or with a > inside an attribute", () => {
    const html =
      '<p>Shown.</p><script/>var a = "Globex secret";</script>' +
      '<script data="/>">var b = "Globex hidden";</script><p>Also shown.</p>';
    expect(htmlText(html)).toBe("Shown.\nAlso shown.");
  });

  it("doesn't let a stray < and an apostrophe swallow the rest of the page", () => {
    expect(htmlText("<p>a < b isn't wrong.</p><p>Globex grows.</p>")).toBe("a\nGlobex grows.");
  });

  it("lets an svg close itself", () => {
    expect(htmlText("<p>Logo:</p><svg/><p>Globex.</p>")).toBe("Logo:\nGlobex.");
  });

  it("keeps the body of a page that never closes its head", () => {
    const html = "<html><head><title>Globex</title><body><p>Globex makes billing simple.</p>";
    expect(htmlText(html)).toBe("Globex makes billing simple.");
  });
});
