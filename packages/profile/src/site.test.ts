import { describe, expect, it } from "vitest";
import { checkSiteProvenance, parseSiteText } from "./site.js";

// The personal site import (NS-209). Invented projects only.

const FILE = [
  "## Ledgerline",
  "Link: https://example.com/ledgerline",
  "- Built a budgeting app used by 40 testers",
  "Shipped weekly releases for 12 weeks",
  "",
  "## Talks",
  "* Spoke at a local meetup on event sourcing",
].join("\n");

describe("parseSiteText", () => {
  it("gives one atom per line, verbatim, with its project's link and no role", () => {
    const parsed = parseSiteText(FILE);
    expect(
      parsed.ok && [
        parsed.value.projects,
        parsed.value.extract.atoms.map((a) => [a.sourceQuote, a.evidenceLink, a.roleKey]),
        parsed.value.extract.links,
        parsed.value.extract.roles,
      ],
    ).toEqual([
      2,
      [
        ["Built a budgeting app used by 40 testers", "https://example.com/ledgerline", null],
        ["Shipped weekly releases for 12 weeks", "https://example.com/ledgerline", null],
        ["Spoke at a local meetup on event sourcing", null, null],
      ],
      [{ label: "Ledgerline", url: "https://example.com/ledgerline" }],
      [],
    ]);
  });

  it("hashes the text, so the same file twice is the same import and a changed one isn't", () => {
    const sha = (text: string) => {
      const r = parseSiteText(text);
      return r.ok ? r.value.textSha256 : "refused";
    };
    expect([
      sha(FILE) === sha(FILE.split("\n").join("\n")),
      sha(FILE) === sha(`${FILE}\n- One more line`),
    ]).toEqual([true, false]);
  });

  it("refuses the whole file and names each bad line", () => {
    const bad = [
      "An intro line before any heading",
      "## Empty project",
      "## Linked",
      "Link: http://example.com/plain",
      "- a claim",
      "Link: https://example.com/second",
      `- ${"x".repeat(501)}`,
    ].join("\n");
    const result = parseSiteText(bad);
    expect(result.ok ? [] : result.error.map((p) => p.line)).toEqual([1, 2, 4, 7]);
  });

  it("refuses a link with a user name and a file with no projects", () => {
    expect([
      parseSiteText("## X\nLink: https://me:pw@example.com\n- a").ok,
      parseSiteText("\n\n"),
    ]).toEqual([
      false,
      { ok: false, error: [{ line: 1, problem: "the file has no ## project headings" }] },
    ]);
  });
});

describe("checkSiteProvenance", () => {
  it("refuses an atom that isn't a line of the file", () => {
    const parsed = parseSiteText(FILE);
    if (!parsed.ok) throw new Error("fixture didn't parse");
    const extract = parsed.value.extract;
    const changed = {
      ...extract,
      atoms: extract.atoms.map((a, i) =>
        i === 0
          ? {
              ...a,
              what: "Built a budgeting app used by 4,000 users",
              sourceQuote: "Built a budgeting app used by 4,000 users",
            }
          : a,
      ),
    };
    expect(checkSiteProvenance(changed, FILE).map((p) => p.problem)).toEqual([
      "atom 1 isn't a line of the file",
    ]);
  });
});
