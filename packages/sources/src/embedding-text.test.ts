import { describe, expect, it } from "vitest";
import { embeddingText, MAX_EMBEDDING_TEXT } from "./embedding-text.js";

// What is sent to the embeddings vendor for a job (NS-129, ADR-0033 item 2). Synthetic jobs only.

const job = {
  title: "Backend Engineer",
  company: "Example Corp",
  requirements: ["5+ years of TypeScript", "  Postgres  ", ""],
};

describe("embeddingText (NS-129)", () => {
  it("is the title, company and requirements lines, one per line", () => {
    expect(embeddingText(job)).toBe(
      "Backend Engineer\nExample Corp\n5+ years of TypeScript\nPostgres",
    );
  });

  it("takes only those three fields, so a URL, pay or description never rides along", () => {
    const full = {
      ...job,
      description: "Apply at https://jobs.example.com/1",
      applyUrl: "https://jobs.example.com/1",
      salaryMin: 150000,
    };
    const text = embeddingText(full) ?? "";
    expect([text.includes("https://"), text.includes("150000")]).toEqual([false, false]);
  });

  it("is null without a title or a company", () => {
    expect(embeddingText({ ...job, title: null })).toBeNull();
    expect(embeddingText({ ...job, company: "  " })).toBeNull();
  });

  it("keeps whole lines up to its limit", () => {
    const long = { ...job, requirements: Array.from({ length: 400 }, (_, i) => `Skill ${i}`) };
    const text = embeddingText(long) ?? "";
    expect(text.length).toBeLessThanOrEqual(MAX_EMBEDDING_TEXT);
    expect(text.split("\n").at(-1)).toMatch(/^Skill \d+$/);
  });
});
