import type { CallRecord, LlmGateway, LlmOutcome } from "@northstar/llm";
import mammoth from "mammoth";
import { describe, expect, it } from "vitest";
import { pdfToText } from "../text.js";
import { diffResume } from "./diff.js";
import { renderResumeDocx } from "./docx.js";
import { tailorToPages } from "./fit.js";
import { resumeTailorInput, tailorWithModel } from "./model-tailor.js";
import { renderResumeText } from "./render.js";
import { type TailorRunDeps, tailorForJob } from "./run.js";
import { tailorResume } from "./tailor.js";
import { sampleJob, sampleMaster } from "./test/master.js";
import { type MasterResume, type MasterWork, TailoredResume } from "./types.js";
import { validateTailoredResume } from "./validate.js";

// The independent-work section in tailored resumes (NS-231, DX-010). Synthetic work only: the
// repo is public.

const WORK: MasterWork = {
  version: 3,
  entries: [
    {
      title: "Open-source rate limiter",
      start: "2025-01",
      end: "2025-06",
      link: null,
      lines: ["Wrote a token-bucket limiter in Go used by two example projects."],
    },
    {
      title: "Ledger reconciliation tool",
      start: "2025-07",
      end: null,
      link: "https://example.com/ledger",
      lines: [
        "Built a reconciliation CLI that compares two ledgers line by line.",
        "Added property tests for rounding across currencies.",
      ],
    },
  ],
};

const withWork = (): MasterResume => ({ ...sampleMaster(), independentWork: WORK });
const job = sampleJob();

describe("the independent-work section in a tailored resume", () => {
  it("holds every entry and line verbatim, ongoing first, each citing its stored position", () => {
    expect(tailorResume(withWork(), job).independentWork).toEqual({
      version: 3,
      entries: [
        {
          entry: 1,
          title: "Ledger reconciliation tool",
          start: "2025-07",
          end: null,
          lines: [
            { line: 0, text: "Built a reconciliation CLI that compares two ledgers line by line." },
            { line: 1, text: "Added property tests for rounding across currencies." },
          ],
        },
        {
          entry: 0,
          title: "Open-source rate limiter",
          start: "2025-01",
          end: "2025-06",
          lines: [
            { line: 0, text: "Wrote a token-bucket limiter in Go used by two example projects." },
          ],
        },
      ],
    });
  });

  it("is left out when there is no stored work", () => {
    expect("independentWork" in tailorResume(sampleMaster(), job)).toBe(false);
    const empty = { ...sampleMaster(), independentWork: { version: 1, entries: [] } };
    expect("independentWork" in tailorResume(empty, job)).toBe(false);
  });

  it("renders under PROJECTS, each entry headed by its title and dates, its lines as bullets", () => {
    const text = renderResumeText(tailorResume(withWork(), job), withWork());
    const block = text.slice(text.indexOf("PROJECTS\n"), text.indexOf("\n\nEDUCATION"));
    expect(block.split("\n").slice(-5)).toEqual([
      "Ledger reconciliation tool · Jul 2025 – Present",
      "- Built a reconciliation CLI that compares two ledgers line by line.",
      "- Added property tests for rounding across currencies.",
      "Open-source rate limiter · Jan 2025 – Jun 2025",
      "- Wrote a token-bucket limiter in Go used by two example projects.",
    ]);
  });
});

describe("validating the independent-work section", () => {
  const tailored = () => tailorResume(withWork(), job);

  it("passes when every line is the stored line it cites", () => {
    expect(validateTailoredResume(tailored(), withWork(), job)).toEqual({ ok: true });
  });

  it("refuses a line that isn't in the stored entries, naming its position, never its text", () => {
    const resume = tailored();
    const line = resume.independentWork?.entries[0]?.lines[1];
    if (line) line.text = "Led a team of 40 engineers.";
    expect(validateTailoredResume(resume, withWork(), job)).toEqual({
      ok: false,
      failures: [
        { item: "independent work entry 0 line 1", problem: "isn't the stored line it cites" },
      ],
    });
  });

  it("refuses a line citing a stored line that doesn't exist", () => {
    const resume = tailored();
    const line = resume.independentWork?.entries[1]?.lines[0];
    if (line) line.line = 4;
    expect(validateTailoredResume(resume, withWork(), job)).toEqual({
      ok: false,
      failures: [
        { item: "independent work entry 1 line 0", problem: "isn't the stored line it cites" },
      ],
    });
  });

  it("refuses a stored line shown twice in one entry", () => {
    const resume = tailored();
    const entry = resume.independentWork?.entries[0];
    const first = entry?.lines[0];
    if (entry && first) entry.lines.push({ ...first });
    expect(validateTailoredResume(resume, withWork(), job)).toEqual({
      ok: false,
      failures: [{ item: "independent work entry 0 line 2", problem: "repeats a stored line" }],
    });
  });

  it("refuses an entry whose title or dates changed, or that cites no stored entry", () => {
    const resume = tailored();
    const [first, second] = resume.independentWork?.entries ?? [];
    if (first) first.end = "2025-12";
    if (second) second.entry = 7;
    expect(validateTailoredResume(resume, withWork(), job)).toEqual({
      ok: false,
      failures: [
        { item: "independent work entry 0", problem: "title or dates aren't the stored entry's" },
        { item: "independent work entry 1", problem: "cites no stored entry" },
      ],
    });
  });

  it("refuses a section when no work is stored, or when it is from another version", () => {
    const resume = tailored();
    expect(validateTailoredResume(resume, sampleMaster(), job)).toEqual({
      ok: false,
      failures: [{ item: "independent work", problem: "no stored independent work" }],
    });
    const newer = { ...sampleMaster(), independentWork: { ...WORK, version: 4 } };
    expect(validateTailoredResume(resume, newer, job)).toEqual({
      ok: false,
      failures: [{ item: "independent work", problem: "is from another stored version" }],
    });
  });
});

describe("the page budget with independent work", () => {
  it("keeps the whole section on the one page and every line readable in the PDF", async () => {
    const fitted = await tailorToPages(withWork(), job);
    expect(fitted.pdf.pages).toBe(1);
    expect(fitted.resume.independentWork?.entries.flatMap((e) => e.lines).length).toBe(3);
    const read = await pdfToText(fitted.pdf.bytes);
    for (const line of WORK.entries.flatMap((e) => e.lines)) expect(read).toContain(line);
  });

  it("drops atom lines, not work lines, when everything doesn't fit", async () => {
    const big = withWork();
    // Many long project atoms: the master alone runs past one page.
    big.atoms = [
      ...big.atoms,
      ...Array.from({ length: 40 }, (_, i) => ({
        id: `extra-${i}`,
        roleId: null,
        what: `Example project ${i}`,
        how: [],
        sourceQuote: `Built example project number ${i} with a long description of the plain work done on it.`,
      })),
    ];
    const fitted = await tailorToPages(big, job);
    expect(fitted.pdf.pages).toBe(1);
    const kept = fitted.resume.sections.flatMap((s) => s.lines).length;
    expect(kept).toBeLessThan(big.atoms.length);
    expect(fitted.resume.independentWork?.entries.flatMap((e) => e.lines).length).toBe(3);
  });
});

describe("the DOCX with independent work", () => {
  it("writes each entry's heading and lines as plain paragraphs", async () => {
    const buffer = await renderResumeDocx(tailorResume(withWork(), job), withWork());
    const lines = (await mammoth.extractRawText({ buffer })).value
      .split("\n")
      .filter((l) => l.trim() !== "");
    expect(lines).toContain("Ledger reconciliation tool · Jul 2025 – Present");
    for (const line of WORK.entries.flatMap((e) => e.lines)) expect(lines).toContain(`- ${line}`);
  });
});

describe("the diff with independent work", () => {
  it("lists each added entry by stored position and line count", () => {
    expect(diffResume(withWork(), tailorResume(withWork(), job)).work).toEqual([
      { entry: 1, lines: 2 },
      { entry: 0, lines: 1 },
    ]);
  });
});

describe("the model route and independent work", () => {
  const record: CallRecord = {
    route: "resume-tailor",
    promptId: "resume-tailor",
    promptVersion: 1,
    modelRequested: "claude-opus-5-5",
    modelServed: "claude-opus-5-5",
    effort: "medium",
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    latencyMs: 1,
    costUsd: 0,
    stopReason: "end_turn",
    refusalCategory: null,
    fallbackUsed: false,
  };

  it("never sends the section to the model", () => {
    const base = tailorResume(withWork(), job);
    expect("independentWork" in resumeTailorInput(withWork(), job, base).base).toBe(false);
  });

  it("puts the deterministic section back on the model's resume", async () => {
    const base = tailorResume(withWork(), job);
    const { independentWork: _w, ...modelOutput } = base;
    const gateway: LlmGateway = {
      async call<I, O>(_route: unknown, _input: I): Promise<LlmOutcome<O>> {
        return { kind: "Ok", output: modelOutput, record } as unknown as LlmOutcome<O>;
      },
    };
    const result = await tailorWithModel({ gateway, enabled: true }, withWork(), job);
    expect(result.kind).toBe("model");
    expect(result.resume.independentWork).toEqual(base.independentWork);
  });

  it("never uses a model resume carrying a section, even if the parse let one through", async () => {
    const forged = {
      ...tailorResume(sampleMaster(), job),
      independentWork: {
        version: 1,
        entries: [{ entry: 0, title: "Invented", start: "2025-01", end: null, lines: [] }],
      },
    };
    const gateway: LlmGateway = {
      async call<I, O>(_route: unknown, _input: I): Promise<LlmOutcome<O>> {
        return { kind: "Ok", output: forged, record } as unknown as LlmOutcome<O>;
      },
    };
    const result = await tailorWithModel({ gateway, enabled: true }, sampleMaster(), job);
    // The validator finds a section with no stored work behind it, so the deterministic resume
    // is used instead; and it has no section, since this master has no work.
    expect(result.kind === "deterministic" && result.reason).toBe("provenance");
    expect("independentWork" in result.resume).toBe(false);
  });

  it("drops a section the model writes into its own output", () => {
    const forged = {
      ...tailorResume(sampleMaster(), job),
      independentWork: { version: 1, entries: [] },
    };
    expect("independentWork" in TailoredResume.parse(forged)).toBe(false);
  });
});

describe("tailorForJob with independent work", () => {
  it("reads the stored work and saves the section with the version", async () => {
    const saved: Record<string, unknown>[] = [];
    const deps: TailorRunDeps = {
      readInput: async () => ({
        ok: true,
        value: {
          profileSourceId: "source-1",
          master: sampleMaster(),
          job: { id: "00000000-0000-4000-8000-000000000001", ...job },
        },
      }),
      save: async (input) => {
        saved.push(input.resume);
        return { version: 1, saved: true };
      },
      readWork: async () => WORK,
    };
    const run = await tailorForJob(deps, "00000000-0000-4000-8000-000000000001", []);
    expect(run.kind === "tailored" && run.validation).toEqual({ ok: true });
    expect((saved[0]?.independentWork as { version: number } | undefined)?.version).toBe(3);
  });
});
