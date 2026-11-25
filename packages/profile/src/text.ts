import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";
import { type PositionedText, pageText } from "./pdf-layout.js";

const MAX_BYTES = 10 * 1024 * 1024;

// Reads a resume file as plain text (CPG-001): .txt and .md as UTF-8, .docx with mammoth, .pdf
// with unpdf (pdf.js). Errors name the file only, never its contents.
export async function fileToText(path: string): Promise<string> {
  const name = basename(path);
  const ext = extname(path).toLowerCase();
  if (![".txt", ".md", ".docx", ".pdf"].includes(ext)) {
    throw new Error(`${name}: only .txt, .md, .docx and .pdf resumes are supported`);
  }
  // The full path, so running from the wrong folder is obvious (it names a location, not contents).
  const info = await stat(path).catch(() => null);
  if (!info) throw new Error(`${name}: not found at ${path}`);
  // A resume is a few hundred KB; a size cap before parsing keeps a zip bomb or a huge PDF from
  // exhausting memory in mammoth or pdf.js.
  if (info.size > MAX_BYTES) throw new Error(`${name}: larger than 10 MB`);
  let text: string;
  if (ext === ".txt" || ext === ".md") {
    text = await readFile(path, "utf8");
  } else if (ext === ".docx") {
    try {
      text = (await mammoth.extractRawText({ path })).value;
    } catch {
      throw new Error(`${name}: could not read the DOCX`);
    }
  } else if (ext === ".pdf") {
    try {
      text = await pdfToText(new Uint8Array(await readFile(path)));
    } catch {
      throw new Error(`${name}: could not read the PDF`);
    }
  } else {
    throw new Error(`${name}: only .txt, .md, .docx and .pdf resumes are supported`);
  }
  if (text.trim() === "") throw new Error(`${name}: no text found`);
  return text;
}

// A PDF's text, the way the resume import reads it: one string per page, pages joined by a blank
// line. The pre-send check (TLR-004) reads rendered resumes back through this same function, so
// it sees what an import would.
export async function pdfToText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes);
  const { text: pages } = await extractText(pdf, { mergePages: false });
  // A two-column page reads one column at a time (NS-134); any other page keeps extractText's
  // reading byte for byte, so imports of single-column PDFs don't change. That reads each page
  // twice, which is cheap at resume size.
  const read: string[] = [];
  for (const [index, plain] of pages.entries()) {
    read.push((await columnText(pdf, index + 1)) ?? plain);
  }
  return read.join("\n\n");
}

type PdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>;

// The page's text read column by column when it has two columns (pdf-layout.ts), else null.
async function columnText(pdf: PdfDocument, pageNumber: number): Promise<string | null> {
  const page = await pdf.getPage(pageNumber);
  const content = await page.getTextContent();
  const items: PositionedText[] = [];
  for (const item of content.items) {
    // Marked-content markers carry no text; text items carry their position in `transform`.
    if (!("str" in item)) continue;
    items.push({ str: item.str, x: item.transform[4], y: item.transform[5], width: item.width });
  }
  return pageText(items, page.getViewport({ scale: 1 }).width);
}
