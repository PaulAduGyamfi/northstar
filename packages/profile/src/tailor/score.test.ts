import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileToText } from "../text.js";
import { renderResumeText } from "./render.js";
import { atsParseCheck, preSendScore } from "./score.js";
import { tailorResume } from "./tailor.js";
import { sampleJob, sampleMaster } from "./test/master.js";

const master = sampleMaster();
const job = sampleJob();
const resume = tailorResume(master, job);
const rendered = renderResumeText(resume, master);

// The render written to a .txt file and read back by our own resume reader.
async function roundTrip(text: string): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "ns117-")), "resume.txt");
  await writeFile(path, text, "utf8");
  return fileToText(path);
}

describe("preSendScore", () => {
  it("reports title match, keyword coverage and a passing ATS check", async () => {
    const reparsed = await roundTrip(rendered);
    expect(preSendScore({ master, job, rendered, reparsed })).toEqual({
      // "Senior" and "Engineer" are shared with a role title; "Platform" isn't.
      title: "partial",
      keywords: { covered: 3, total: 4, missing: ["Kubernetes"] },
      ats: { recovered: 1, missingHeaders: [], pass: true },
    });
  });

  it("reports an exact title match when the resume names the job title", () => {
    const named = { ...job, title: "Senior Software Engineer" };
    expect(preSendScore({ master, job: named, rendered, reparsed: rendered }).title).toBe("exact");
  });

  it("reports an unknown title match when the job has no title", () => {
    const untitled = { ...job, title: null };
    expect(preSendScore({ master, job: untitled, rendered, reparsed: rendered }).title).toBe(
      "unknown",
    );
  });

  it("reports no title match when no significant word is shared", () => {
    const other = { ...job, title: "Data Analyst" };
    expect(preSendScore({ master, job: other, rendered, reparsed: rendered }).title).toBe("none");
  });
});

describe("atsParseCheck", () => {
  it("fails when the re-parse loses a section header", () => {
    const reparsed = rendered.replace("SKILLS\n", "");
    expect(atsParseCheck(rendered, reparsed)).toEqual({
      recovered: 0.989,
      missingHeaders: ["SKILLS"],
      pass: false,
    });
  });

  it("fails when the re-parse recovers less than 95% of the words", () => {
    // Drops the two longest bullets (30 of the 92 words); every header survives.
    const reparsed = rendered
      .split("\n")
      .filter((l) => !l.startsWith("- Led") && !l.startsWith("- Made"))
      .join("\n");
    expect(atsParseCheck(rendered, reparsed)).toEqual({
      recovered: 0.674,
      missingHeaders: [],
      pass: false,
    });
  });
});
