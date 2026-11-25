import mammoth from "mammoth";
import { describe, expect, it } from "vitest";
import { pdfToText } from "../text.js";
import { renderResumeDocx } from "./docx.js";
import { preSendScoreFromPdf, tailorToPages } from "./fit.js";
import { renderResumePdf } from "./pdf.js";
import { HEADERS } from "./render.js";
import { tailorResume } from "./tailor.js";
import { sampleJob, sampleMaster } from "./test/master.js";
import type { MasterResume, TailoredResume } from "./types.js";

const master = sampleMaster();
const job = sampleJob();

// A synthetic master too long for one page: 60 invented bullets in one role, each long enough to
// wrap onto a second line.
const LONG = 60;
function longMaster(): MasterResume {
  const m = sampleMaster();
  m.atoms = Array.from({ length: LONG }, (_, i) => ({
    id: `long-${i + 1}`,
    roleId: "role-1",
    what: `Shipped billing feature ${i + 1}`,
    how: ["Go", "Postgres"],
    sourceQuote: `• Shipped billing feature ${i + 1} in Go and Postgres for the payments team, with integration tests, a staged rollout behind a flag, dashboards for its error rate and an on-call runbook.`,
  }));
  return m;
}
const lineCount = (r: TailoredResume) => r.sections.reduce((n, s) => n + s.lines.length, 0);

describe("renderResumePdf", () => {
  it("renders the sample resume to one page that re-parses with every header and 95% of the words", async () => {
    const resume = tailorResume(master, job);
    const pdf = await renderResumePdf(resume, master);
    const score = await preSendScoreFromPdf({ master, job, resume, pdf: pdf.bytes });
    expect([pdf.pages, score.ats.pass, score.ats.missingHeaders]).toEqual([1, true, []]);
    expect(score.ats.recovered).toBeGreaterThanOrEqual(0.95);
  });

  it("takes employer, title and dates from the master", async () => {
    const text = await pdfToText((await renderResumePdf(tailorResume(master, job), master)).bytes);
    expect(text).toContain("Senior Software Engineer, Example Payments · Mar 2021 – Present");
  });

  it("replaces a character Helvetica can't encode instead of throwing", async () => {
    const resume = tailorResume(master, job);
    const line = resume.sections[0]?.lines[0];
    if (line) line.text = "Made payment retries idempotent ✓ in Go and Postgres.";
    const text = await pdfToText((await renderResumePdf(resume, master)).bytes);
    expect(text).toContain("idempotent ? in Go");
  });

  it("wraps a long line instead of running off the page", async () => {
    const resume = tailorResume(longMaster(), job, { maxLines: 1 });
    const text = await pdfToText((await renderResumePdf(resume, longMaster())).bytes);
    expect(text).toContain("on-call runbook.");
  });

  it("breaks a word wider than the page so all of it is still read back", async () => {
    const resume = tailorResume(master, job);
    const line = resume.sections[0]?.lines[0];
    const token = "x".repeat(300);
    if (line) line.text = `Made payment retries idempotent ${token} in Go.`;
    const text = await pdfToText((await renderResumePdf(resume, master)).bytes);
    expect(text.replace(/\s/g, "")).toContain(token);
  });

  it("leaves the caller's PDF bytes intact after scoring them", async () => {
    const resume = tailorResume(master, job);
    const pdf = await renderResumePdf(resume, master);
    const before = pdf.bytes.byteLength;
    await preSendScoreFromPdf({ master, job, resume, pdf: pdf.bytes });
    expect([before > 0, pdf.bytes.byteLength]).toEqual([true, before]);
  });
});

describe("renderResumeDocx", () => {
  it("replaces a control character XML forbids instead of writing a broken file", async () => {
    const resume = tailorResume(master, job);
    const line = resume.sections[0]?.lines[0];
    if (line) line.text = "Made payment retries\u0001 idempotent in Go and Postgres.";
    const buffer = await renderResumeDocx(resume, master);
    const text = (await mammoth.extractRawText({ buffer })).value;
    expect(text).toContain("- Made payment retries? idempotent in Go and Postgres.");
  });

  it("writes every header and bullet line as plain paragraphs", async () => {
    const resume = tailorResume(master, job);
    const buffer = await renderResumeDocx(resume, master);
    const text = (await mammoth.extractRawText({ buffer })).value;
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    for (const h of HEADERS.filter((h) => h !== "SUMMARY")) expect(lines).toContain(h);
    for (const l of resume.sections.flatMap((s) => s.lines)) expect(lines).toContain(`- ${l.text}`);
  });
});

describe("tailorToPages (TLR-001)", () => {
  it("brings a resume that runs over one page back to one page", async () => {
    const long = longMaster();
    const all = await renderResumePdf(tailorResume(long, job, { maxLines: LONG }), long);
    const fitted = await tailorToPages(long, job);
    expect([all.pages > 1, fitted.pdf.pages]).toEqual([true, 1]);
    expect(lineCount(fitted.resume)).toBeLessThan(
      lineCount(tailorResume(long, job, { maxLines: LONG })),
    );
  });

  it("keeps more lines when two pages are allowed", async () => {
    const long = longMaster();
    const one = await tailorToPages(long, job);
    const two = await tailorToPages(long, job, { maxPages: 2 });
    expect(two.pdf.pages).toBeLessThanOrEqual(2);
    expect(lineCount(two.resume)).toBeGreaterThan(lineCount(one.resume));
  });

  it("keeps every line when the whole resume already fits", async () => {
    const fitted = await tailorToPages(master, job);
    expect(lineCount(fitted.resume)).toBe(master.atoms.length);
  });
});
