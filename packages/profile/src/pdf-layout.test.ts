import { describe, expect, it } from "vitest";
import { type PositionedText, pageText } from "./pdf-layout.js";

// Synthetic text items as pdf.js reports them: x and y in points from the bottom left, y going
// up the page. A letter page is 612 points wide. Invented content only (the repo is public).
const WIDTH = 612;
const at = (x: number, row: number, str: string): PositionedText => ({
  str,
  x,
  y: 720 - row * 14,
  // About 5 points per character at 10 pt Helvetica.
  width: str.length * 5,
});
const left = (row: number, str: string) => at(72, row, str);
const right = (row: number, str: string) => at(340, row, str);

describe("pageText", () => {
  it("reads the left column top to bottom, then the right column", () => {
    const items = [
      left(0, "Taylor Sample"),
      right(0, "SKILLS"),
      left(1, "EXPERIENCE"),
      right(1, "Go"),
      left(2, "• Built the billing service"),
      right(2, "Postgres"),
      left(3, "in Go and Postgres."),
      right(4, "Kubernetes"),
    ];
    expect(pageText(items, WIDTH)).toBe(
      "Taylor Sample\nEXPERIENCE\n• Built the billing service\nin Go and Postgres.\n\nSKILLS\nGo\nPostgres\nKubernetes",
    );
  });

  it("keeps a row that crosses the gutter in place and reads each band's columns in turn", () => {
    const items = [
      at(72, 0, "Taylor Sample · Staff Engineer · taylor@example.com · Remote"),
      left(1, "EXPERIENCE"),
      right(1, "SKILLS"),
      left(2, "Staff Engineer, Example Freight"),
      right(2, "Go"),
      left(3, "• Led the routing rewrite."),
      right(3, "Kubernetes"),
      right(4, "AWS"),
    ];
    expect(pageText(items, WIDTH)).toBe(
      "Taylor Sample · Staff Engineer · taylor@example.com · Remote\n\nEXPERIENCE\nStaff Engineer, Example Freight\n• Led the routing rewrite.\n\nSKILLS\nGo\nKubernetes\nAWS",
    );
  });

  it("joins the pieces of one line left to right, with a space only where there is a gap", () => {
    const items = [
      { str: "Built", x: 72, y: 720, width: 25 },
      { str: "the", x: 100, y: 720, width: 15 },
      { str: ",", x: 115, y: 720, width: 3 },
      left(1, "b"),
      left(2, "c"),
      right(0, "x"),
      right(1, "y"),
      right(3, "z"),
    ];
    expect(pageText(items, WIDTH)).toBe("Built the,\nb\nc\n\nx\ny\nz");
  });

  it("returns null for a single column, so the page reads as before", () => {
    const items = [0, 1, 2, 3, 4].map((row) => left(row, `Line ${row} of a plain resume`));
    expect(pageText(items, WIDTH)).toBeNull();
  });

  it("returns null when the only gap is outside the middle half of the page", () => {
    const items = [0, 1, 2].flatMap((row) => [left(row, "Text"), at(520, row, "2024")]);
    expect(pageText(items, WIDTH)).toBeNull();
  });

  it("returns null when a side has fewer than 3 lines", () => {
    const items = [left(0, "A"), left(1, "B"), left(2, "C"), right(0, "X"), right(1, "Y")];
    expect(pageText(items, WIDTH)).toBeNull();
  });

  it("returns null when most lines cross the would-be gutter (indented single column)", () => {
    const long = "A long line of a one-column resume that runs across the page.";
    const items = [
      at(72, 0, long),
      at(72, 1, long),
      at(72, 2, long),
      at(72, 3, "Short"),
      at(72, 4, "Short"),
      at(72, 5, "Short"),
      at(340, 3, "indented"),
      at(340, 4, "indented"),
      at(340, 5, "indented"),
    ];
    expect(pageText(items, WIDTH)).toBeNull();
  });

  it("returns null when every right-hand line shares its line with left-hand text", () => {
    const items = [0, 1, 2, 3].flatMap((row) => [left(row, `Entry ${row}`), right(row, "2020")]);
    expect(pageText(items, WIDTH)).toBeNull();
  });

  it("returns null for one column with right-aligned dates, so dates stay with their entries", () => {
    // An A4 page (595 points): every date shares its line with the entry it belongs to.
    const date = (row: number, str: string) => at(440, row, str);
    const items = [
      at(250, 0, "EDUCATION"),
      left(1, "MSc Computer Science, Example University"),
      date(1, "2012 – 2014"),
      left(2, "BSc Mathematics, Sample College"),
      date(2, "2008 – 2012"),
      at(240, 3, "CERTIFICATIONS"),
      left(4, "Example Cloud Practitioner"),
      at(470, 4, "2021"),
      left(5, "Skills: Go, Postgres"),
      left(6, "Languages: English"),
    ];
    expect(pageText(items, 595)).toBeNull();
  });

  it("returns null for a page with no text", () => {
    expect(pageText([{ str: " ", x: 72, y: 720, width: 3 }], WIDTH)).toBeNull();
  });
});
