import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";

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
      const pdf = await getDocumentProxy(new Uint8Array(await readFile(path)));
      // One string per page, pages joined by a blank line.
      const { text: pages } = await extractText(pdf, { mergePages: false });
      text = pages.join("\n\n");
    } catch {
      throw new Error(`${name}: could not read the PDF`);
    }
  } else {
    throw new Error(`${name}: only .txt, .md, .docx and .pdf resumes are supported`);
  }
  if (text.trim() === "") throw new Error(`${name}: no text found`);
  return text;
}
