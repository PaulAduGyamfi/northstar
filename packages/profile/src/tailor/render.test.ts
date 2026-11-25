import { describe, expect, it } from "vitest";
import { HEADERS, renderResumeText } from "./render.js";
import { tailorResume } from "./tailor.js";
import { sampleJob, sampleMaster } from "./test/master.js";

describe("renderResumeText", () => {
  it("renders a single-column resume with locked facts from the master", () => {
    const master = sampleMaster();
    expect(renderResumeText(tailorResume(master, sampleJob()), master)).toBe(
      [
        "EXPERIENCE",
        "Senior Software Engineer, Example Payments · Mar 2021 – Present",
        "- Made payment retries idempotent in Go and Postgres, cutting duplicate charges to zero.",
        "- Wrote the on-call runbook and the Terraform for its alerts.",
        "- Led a team of 4 engineers through the ledger migration, moving 120 million rows with no downtime.",
        "",
        "Software Engineer, Sample Logistics · Jun 2017 – Feb 2021",
        "- Built a route planner in Python that cut planning time by 35%.",
        "",
        "PROJECTS",
        "- Maintain an open-source Kafka consumer library.",
        "",
        "EDUCATION",
        "BSc, Computer Science, Example State University · 2017",
        "",
        "SKILLS",
        "Terraform, Postgres, Python, Go, Kafka",
        "",
      ].join("\n"),
    );
  });

  it("adds a summary section only when the resume has summary lines", () => {
    const master = sampleMaster();
    const resume = tailorResume(master, sampleJob());
    resume.summary = [{ text: "Payments engineer.", atomIds: ["atom-1"] }];
    expect(renderResumeText(resume, master).startsWith("SUMMARY\nPayments engineer.\n\n")).toBe(
      true,
    );
  });

  it("shows no Present for a role whose end date is unknown", () => {
    const master = sampleMaster();
    const [first] = master.roles;
    if (first) first.isCurrent = false;
    const text = renderResumeText(tailorResume(master, sampleJob()), master);
    expect(text.split("\n")[1]).toBe("Senior Software Engineer, Example Payments · Mar 2021");
  });

  it("lists the headers the render can use", () => {
    expect(HEADERS).toEqual(["SUMMARY", "EXPERIENCE", "PROJECTS", "EDUCATION", "SKILLS"]);
  });
});
