import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fileToText } from "./text.js";
import { normalize } from "./validate.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`./test/fixtures/${name}`, import.meta.url));
const LINES = [
  "Alex Example",
  "Senior Software Engineer, Example Payments",
  "Made payment retries idempotent in Go and Postgres.",
];

describe("fileToText", () => {
  it("reads a .txt or .md resume as UTF-8", async () => {
    const dir = mkdtempSync(join(tmpdir(), "resume-"));
    writeFileSync(join(dir, "r.md"), "# Alex Example\n\n- Wrote the “on-call” runbook.\n");
    expect(await fileToText(join(dir, "r.md"))).toBe(
      "# Alex Example\n\n- Wrote the “on-call” runbook.\n",
    );
  });

  it("reads the text of a .docx resume", async () => {
    const text = await fileToText(fixture("sample.docx"));
    for (const line of LINES) expect(text).toContain(line);
  });

  it("reads the text of a .pdf resume", async () => {
    const text = await fileToText(fixture("sample.pdf"));
    for (const line of LINES) expect(text).toContain(line);
  });

  it("reads a single-column .pdf exactly as pdf.js's plain reading does", async () => {
    expect(await fileToText(fixture("sample.pdf"))).toBe(LINES.join("\n"));
  });

  it("reads a two-column .pdf one column at a time, so each bullet stays whole", async () => {
    // The `two-column-pdf` eval case's content as a real two-column PDF (make-fixtures.py).
    expect(await fileToText(fixture("two-column.pdf"))).toBe(
      [
        "Riley Example",
        "Platform Engineer",
        "EXPERIENCE",
        "Platform Engineer, Northgate Systems",
        "June 2019 – Present",
        "• Rebuilt the deploy pipeline with",
        "GitHub Actions, cutting deploys from",
        "40 minutes to 9.",
        "• Ran the Kubernetes upgrade to 1.29.",
        "",
        "SKILLS",
        "Terraform",
        "Kubernetes",
        "AWS",
        "CERTIFICATIONS",
        "Example Cloud Practitioner (Example Cloud)",
      ].join("\n"),
    );
  });

  it("keeps a wrapped two-column bullet quotable verbatim, as the provenance check needs", async () => {
    const text = normalize(await fileToText(fixture("two-column.pdf")));
    const quote =
      "• Rebuilt the deploy pipeline with GitHub Actions, cutting deploys from 40 minutes to 9.";
    expect(text.includes(normalize(quote))).toBe(true);
  });

  it("refuses other file types by name", async () => {
    await expect(fileToText("/tmp/resume.pages")).rejects.toThrow(
      "resume.pages: only .txt, .md, .docx and .pdf resumes are supported",
    );
  });

  it("names the file when a PDF can't be read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "resume-"));
    writeFileSync(join(dir, "broken.pdf"), "not a pdf");
    await expect(fileToText(join(dir, "broken.pdf"))).rejects.toThrow(
      "broken.pdf: could not read the PDF",
    );
  });

  it("says where it looked when the file isn't there", async () => {
    const dir = mkdtempSync(join(tmpdir(), "resume-"));
    await expect(fileToText(join(dir, "resume.pdf"))).rejects.toThrow(
      `resume.pdf: not found at ${join(dir, "resume.pdf")}`,
    );
  });

  it("refuses a file over 10 MB before parsing it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "resume-"));
    writeFileSync(join(dir, "huge.pdf"), Buffer.alloc(10 * 1024 * 1024 + 1));
    await expect(fileToText(join(dir, "huge.pdf"))).rejects.toThrow("huge.pdf: larger than 10 MB");
  });

  it("refuses an empty resume", async () => {
    const dir = mkdtempSync(join(tmpdir(), "resume-"));
    writeFileSync(join(dir, "empty.txt"), "  \n");
    await expect(fileToText(join(dir, "empty.txt"))).rejects.toThrow("empty.txt: no text found");
  });
});
