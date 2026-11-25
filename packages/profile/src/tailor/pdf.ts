import { PDFDocument, type PDFFont, StandardFonts } from "pdf-lib";
import { HEADERS, renderResumeText } from "./render.js";
import type { MasterResume, TailoredResume } from "./types.js";

// The ATS-safe PDF resume (TLR-005, NS-144 → NS-145, ADR-0020). It lays out the lines of
// renderResumeText, so the PDF has the plain text's headers, order and locked facts. One column,
// Helvetica (a standard font, nothing embedded, text extractable), no tables, images or columns.

// US Letter in points, with 0.75-inch margins.
const PAGE = { width: 612, height: 792 };
const MARGIN = 54;
const BODY_SIZE = 10;
const HEADER_SIZE = 11;
// Line height as a multiple of the font size.
const LEADING = 1.35;

export type RenderedPdf = { bytes: Uint8Array; pages: number };

const HEADER_SET = new Set<string>(HEADERS);

// Text Helvetica can encode: any other character becomes "?", which the re-parse check then
// counts as a missed word, so it shows instead of throwing or vanishing.
function encodable(font: PDFFont, text: string): string {
  let out = "";
  for (const ch of text) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += "?";
    }
  }
  return out;
}

// Words greedily packed into lines no wider than `width` points. A word wider than the line on
// its own goes on a line of its own (it can't be split without changing it).
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    const next = current === "" ? word : `${current} ${word}`;
    if (current !== "" && font.widthOfTextAtSize(next, size) > width) {
      lines.push(current);
      current = word;
    } else current = next;
  }
  lines.push(current);
  return lines;
}

export async function renderResumePdf(
  resume: TailoredResume,
  master: MasterResume,
): Promise<RenderedPdf> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const width = PAGE.width - 2 * MARGIN;
  let page = doc.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - MARGIN;

  const draw = (text: string, font: PDFFont, size: number) => {
    const step = size * LEADING;
    if (y - step < MARGIN) {
      page = doc.addPage([PAGE.width, PAGE.height]);
      y = PAGE.height - MARGIN;
    }
    y -= step;
    page.drawText(text, { x: MARGIN, y, size, font });
  };

  for (const line of renderResumeText(resume, master).trimEnd().split("\n")) {
    if (line === "") {
      // A blank line between blocks, as in the text render.
      y -= BODY_SIZE * LEADING * 0.6;
      continue;
    }
    if (HEADER_SET.has(line)) {
      draw(line, bold, HEADER_SIZE);
      continue;
    }
    for (const part of wrap(encodable(regular, line), regular, BODY_SIZE, width)) {
      draw(part, regular, BODY_SIZE);
    }
  }
  return { bytes: await doc.save(), pages: doc.getPageCount() };
}
