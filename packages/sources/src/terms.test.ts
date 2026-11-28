import { describe, expect, it } from "vitest";
import { termsFor } from "./terms.js";

// Terms status per source (ADR-0003). Synthetic links only; nothing is fetched.

describe("termsFor", () => {
  it("calls YC's own site and Work at a Startup prohibited (NS-288, #477)", () => {
    expect(
      [
        "https://www.ycombinator.com/companies/globex/jobs/abc123-backend-engineer",
        "https://ycombinator.com/jobs",
        "https://www.workatastartup.com/jobs/12345",
        "https://workatastartup.com/companies/globex",
      ].map((url) => termsFor(url).terms),
    ).toEqual(["prohibited", "prohibited", "prohibited", "prohibited"]);
  });

  it("leaves HN's own pages alone, where the Who is hiring? thread's postings link (NS-282)", () => {
    expect(termsFor("https://news.ycombinator.com/item?id=1001").terms).not.toBe("prohibited");
  });

  it("matches YC by host, not by a lookalike that only contains its name", () => {
    expect(termsFor("https://ycombinator.com.example.com/jobs").terms).not.toBe("prohibited");
  });
});
