import { describe, expect, it } from "vitest";
import { detectBoard } from "./detect.js";

// Invented companies only.
describe("detectBoard", () => {
  it("reads the ATS and board id from each of the five board URL shapes", () => {
    expect(detectBoard("https://boards.greenhouse.io/globex")).toEqual({
      ats: "greenhouse",
      board: "globex",
      url: "https://boards.greenhouse.io/globex",
    });
    expect(detectBoard("https://job-boards.greenhouse.io/globex/")?.board).toBe("globex");
    expect(detectBoard("https://jobs.lever.co/initech")).toEqual({
      ats: "lever",
      board: "initech",
      url: "https://jobs.lever.co/initech",
    });
    expect(detectBoard("https://jobs.ashbyhq.com/hooli")).toEqual({
      ats: "ashby",
      board: "hooli",
      url: "https://jobs.ashbyhq.com/hooli",
    });
    expect(detectBoard("https://jobs.smartrecruiters.com/Acme")).toEqual({
      ats: "smartrecruiters",
      board: "Acme",
      url: "https://jobs.smartrecruiters.com/Acme",
    });
    expect(detectBoard("https://apply.workable.com/umbrella/")).toEqual({
      ats: "workable",
      board: "umbrella",
      url: "https://apply.workable.com/umbrella",
    });
  });

  it("folds Greenhouse and Lever board names to lower case, so one board is one watch", () => {
    expect(detectBoard("https://boards.greenhouse.io/Globex")).toEqual({
      ats: "greenhouse",
      board: "globex",
      url: "https://boards.greenhouse.io/globex",
    });
    expect(detectBoard("https://jobs.lever.co/InItech")?.board).toBe("initech");
    // Unverified for these ATSs, so kept exactly as typed.
    expect(detectBoard("https://jobs.smartrecruiters.com/Acme")?.board).toBe("Acme");
  });

  it("drops tracking parameters and fragments from the stored board URL", () => {
    expect(detectBoard("https://boards.greenhouse.io/globex?gh_src=abc#top")?.url).toBe(
      "https://boards.greenhouse.io/globex",
    );
  });

  it("refuses a single posting's link: that is jobs add, not a board", () => {
    expect(detectBoard("https://boards.greenhouse.io/globex/jobs/4012345")).toBeNull();
    expect(
      detectBoard("https://jobs.lever.co/initech/0c9a4b1e-1111-4222-8333-444455556666"),
    ).toBeNull();
  });

  it("refuses http, look-alike hosts, other sites and odd board ids", () => {
    expect(detectBoard("http://boards.greenhouse.io/globex")).toBeNull();
    expect(detectBoard("https://boards.greenhouse.io.evil.example/globex")).toBeNull();
    expect(detectBoard("https://globex.example.com/careers")).toBeNull();
    expect(detectBoard("https://www.linkedin.com/company/globex/jobs")).toBeNull();
    expect(detectBoard("https://jobs.lever.co/%2e%2e")).toBeNull();
    expect(detectBoard("https://jobs.ashbyhq.com/")).toBeNull();
    expect(detectBoard("not a link")).toBeNull();
  });

  // NS-260: a Workday career site is one board per tenant, data center and site.
  it("reads a Workday career site, with or without a locale, as tenant.wdN/site", () => {
    const want = {
      ats: "workday",
      board: "initech.wd5/Careers",
      url: "https://initech.wd5.myworkdayjobs.com/Careers",
    };
    expect(detectBoard("https://initech.wd5.myworkdayjobs.com/Careers")).toEqual(want);
    expect(detectBoard("https://Initech.wd5.myworkdayjobs.com/en-US/Careers/?q=x")).toEqual(want);
  });

  it("refuses a Workday posting link, a bare Workday host and an odd site name", () => {
    expect(
      detectBoard("https://initech.wd5.myworkdayjobs.com/Careers/job/Remote/Engineer_R-1001"),
    ).toBeNull();
    expect(detectBoard("https://initech.wd5.myworkdayjobs.com/")).toBeNull();
    expect(detectBoard("https://initech.wd5.myworkdayjobs.com/en-US")).toBeNull();
    expect(detectBoard("https://initech.wd5.myworkdayjobs.com/%2e%2e")).toBeNull();
    expect(detectBoard("https://initech.myworkdayjobs.com/Careers")).toBeNull();
  });
});
