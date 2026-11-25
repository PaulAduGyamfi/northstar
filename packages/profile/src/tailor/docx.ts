import { Document, Packer, Paragraph, TextRun } from "docx";
import { HEADERS, renderResumeText } from "./render.js";
import type { MasterResume, TailoredResume } from "./types.js";

// The ATS-safe DOCX resume (TLR-005, NS-145, ADR-0020): the lines of renderResumeText as plain
// paragraphs in one section. Headers are bold; bullets stay "- " text (no numbering, tables or
// columns a parser could scramble).

const HEADER_SET = new Set<string>(HEADERS);

export async function renderResumeDocx(
  resume: TailoredResume,
  master: MasterResume,
): Promise<Buffer> {
  const paragraphs = renderResumeText(resume, master)
    .trimEnd()
    .split("\n")
    .map(
      (line) =>
        new Paragraph({
          children: [
            new TextRun({ text: line, bold: HEADER_SET.has(line), font: "Arial", size: 20 }),
          ],
        }),
    );
  const doc = new Document({ sections: [{ children: paragraphs }] });
  return Packer.toBuffer(doc);
}
