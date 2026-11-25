import { describe, expect, it } from "vitest";
import { fakeWeb } from "../test/fake-web.js";
import { ashby } from "./ashby.js";
import { detectAts } from "./detect.js";
import { greenhouse } from "./greenhouse.js";
import { lever } from "./lever.js";
import { postedOn, workday } from "./workday.js";

// Synthetic API responses shaped like each ATS's public JSON (invented companies and ids).
const LEVER_ID = "0c9a4b1e-1111-4222-8333-444455556666";
const ASHBY_ID = "7d2e9f30-aaaa-4bbb-8ccc-ddddeeeeffff";
const NOW = new Date("2026-11-25T12:00:00Z");

describe("detectAts", () => {
  it("reads the board and posting id from each ATS's URL shape", () => {
    expect(detectAts("https://boards.greenhouse.io/globex/jobs/4012345")).toEqual({
      ats: "greenhouse",
      board: "globex",
      postingId: "4012345",
    });
    expect(detectAts("https://job-boards.greenhouse.io/globex/jobs/4012345?gh_src=x")?.ats).toBe(
      "greenhouse",
    );
    expect(detectAts(`https://jobs.lever.co/initech/${LEVER_ID}/apply`)).toEqual({
      ats: "lever",
      company: "initech",
      postingId: LEVER_ID,
    });
    expect(detectAts(`https://jobs.ashbyhq.com/hooli/${ASHBY_ID}`)).toEqual({
      ats: "ashby",
      org: "hooli",
      postingId: ASHBY_ID,
    });
    expect(
      detectAts(
        "https://acme.wd5.myworkdayjobs.com/en-US/External/job/Remote-US/Backend-Engineer_JR-1042",
      ),
    ).toEqual({
      ats: "workday",
      host: "acme.wd5.myworkdayjobs.com",
      tenant: "acme",
      site: "External",
      path: "job/Remote-US/Backend-Engineer_JR-1042",
      postingId: "acme/JR-1042",
    });
  });

  it("scopes a Workday requisition id by tenant, so two companies' R-00123 differ", () => {
    const a = detectAts("https://acme.wd5.myworkdayjobs.com/External/job/NYC/Engineer_R-00123");
    const b = detectAts("https://globex.wd1.myworkdayjobs.com/Careers/job/NYC/Engineer_R-00123");
    expect([a?.postingId, b?.postingId]).toEqual(["acme/R-00123", "globex/R-00123"]);
  });

  it("reads SmartRecruiters and Workable posting links with the same ids their boards give", () => {
    expect(
      detectAts("https://jobs.smartrecruiters.com/Acme/744000012345678-site-reliability-engineer"),
    ).toEqual({ ats: "smartrecruiters", company: "Acme", postingId: "744000012345678" });
    expect(detectAts("https://apply.workable.com/Umbrella/j/A1B2C3D4E5/")).toEqual({
      ats: "workable",
      account: "Umbrella",
      postingId: "umbrella/A1B2C3D4E5",
    });
    expect(detectAts("https://jobs.smartrecruiters.com/Acme")).toBeNull();
    expect(detectAts("https://apply.workable.com/umbrella/")).toBeNull();
  });

  it("returns null for any other page, including look-alike hosts", () => {
    expect(detectAts("https://globex.example.com/careers/backend")).toBeNull();
    expect(detectAts("https://boards.greenhouse.io.evil.example/globex/jobs/1")).toBeNull();
    expect(detectAts("https://boards.greenhouse.io/globex")).toBeNull();
  });
});

describe("greenhouse", () => {
  const api =
    "https://boards-api.greenhouse.io/v1/boards/globex/jobs/4012345?pay_transparency=true";

  it("maps the posting, its pay range and its escaped HTML description", async () => {
    const { deps } = fakeWeb({
      [api]: {
        body: {
          id: 4012345,
          title: "Senior Backend Engineer",
          company_name: "Globex",
          absolute_url: "https://boards.greenhouse.io/globex/jobs/4012345",
          location: { name: "Remote - US" },
          content: "&lt;p&gt;Build payment APIs &amp;amp; services.&lt;/p&gt;",
          first_published: "2026-11-24T09:00:00-05:00",
          pay_input_ranges: [{ min_cents: 15000000, max_cents: 18000000, currency_type: "USD" }],
        },
      },
    });
    const x = await greenhouse(deps, { board: "globex", postingId: "4012345" });
    expect(x).toMatchObject({ method: "ats_api", ats: "greenhouse", atsPostingId: "4012345" });
    expect(x?.fields).toMatchObject({
      title: "Senior Backend Engineer",
      company: "Globex",
      location: "Remote - US",
      remote: "remote",
      salaryMin: 150000,
      salaryMax: 180000,
      salaryCurrency: "USD",
      salaryPeriod: "year",
      description: "Build payment APIs & services.",
      postedAt: new Date("2026-11-24T14:00:00Z"),
    });
  });

  it("returns null when the API answers 404 or with an unexpected shape", async () => {
    expect(await greenhouse(fakeWeb({}).deps, { board: "globex", postingId: "1" })).toBeNull();
    const odd = fakeWeb({ [api]: { body: { jobs: [] } } });
    expect(await greenhouse(odd.deps, { board: "globex", postingId: "4012345" })).toBeNull();
  });
});

describe("lever", () => {
  it("maps the posting, its lists into requirements and nice-to-haves, and its salary", async () => {
    const { deps } = fakeWeb({
      [`https://api.lever.co/v0/postings/initech/${LEVER_ID}`]: {
        body: {
          id: LEVER_ID,
          text: "Platform Engineer",
          categories: { location: "Austin, TX", commitment: "Full-time" },
          workplaceType: "hybrid",
          descriptionPlain: "Initech runs the platform.",
          lists: [
            { text: "Requirements", content: "<li>Go or TypeScript</li><li>Kubernetes</li>" },
            { text: "Nice to have", content: "<li>Payments background</li>" },
          ],
          hostedUrl: `https://jobs.lever.co/initech/${LEVER_ID}`,
          applyUrl: `https://jobs.lever.co/initech/${LEVER_ID}/apply`,
          createdAt: 1764000000000,
          salaryRange: { min: 140000, max: 170000, currency: "USD", interval: "per-year-salary" },
        },
      },
    });
    const x = await lever(deps, { company: "initech", postingId: LEVER_ID });
    expect(x?.fields).toMatchObject({
      title: "Platform Engineer",
      company: "initech",
      remote: "hybrid",
      requirements: ["Go or TypeScript", "Kubernetes"],
      niceToHaves: ["Payments background"],
      salaryMin: 140000,
      salaryPeriod: "year",
      applyUrl: `https://jobs.lever.co/initech/${LEVER_ID}/apply`,
      postedAt: new Date(1764000000000),
    });
  });
});

describe("ashby", () => {
  it("picks the posting out of the board and reads its salary component", async () => {
    const { deps } = fakeWeb({
      "https://api.ashbyhq.com/posting-api/job-board/hooli?includeCompensation=true": {
        body: {
          jobs: [
            { id: "other-id", title: "Designer" },
            {
              id: ASHBY_ID.toUpperCase(),
              title: "Data Engineer",
              location: "New York",
              isRemote: false,
              workplaceType: "OnSite",
              descriptionPlain: "Pipelines.",
              publishedAt: "2026-11-23T15:00:00.000Z",
              jobUrl: `https://jobs.ashbyhq.com/hooli/${ASHBY_ID}`,
              applyUrl: `https://jobs.ashbyhq.com/hooli/${ASHBY_ID}/application`,
              compensation: {
                summaryComponents: [
                  {
                    compensationType: "Salary",
                    interval: "1 YEAR",
                    currencyCode: "USD",
                    minValue: 160000,
                    maxValue: 200000,
                  },
                ],
              },
            },
          ],
        },
      },
    });
    const x = await ashby(deps, { org: "hooli", postingId: ASHBY_ID });
    expect(x?.fields).toMatchObject({
      title: "Data Engineer",
      company: "hooli",
      remote: "onsite",
      salaryMin: 160000,
      salaryMax: 200000,
      salaryPeriod: "year",
    });
  });

  it("returns null when the posting isn't on the board", async () => {
    const { deps } = fakeWeb({
      "https://api.ashbyhq.com/posting-api/job-board/hooli?includeCompensation=true": {
        body: { jobs: [] },
      },
    });
    expect(await ashby(deps, { org: "hooli", postingId: ASHBY_ID })).toBeNull();
  });
});

describe("workday", () => {
  it("maps the posting and the hiring organization's name", async () => {
    const { deps } = fakeWeb({
      "https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/job/Remote-US/Backend-Engineer_JR-1042":
        {
          body: {
            jobPostingInfo: {
              title: "Backend Engineer",
              jobDescription: "<p>Own the <b>ledger</b> service.</p>",
              location: "Remote - US",
              postedOn: "Posted 3 Days Ago",
              jobReqId: "JR-1042",
              externalUrl:
                "https://acme.wd5.myworkdayjobs.com/External/job/Remote-US/Backend-Engineer_JR-1042",
            },
            hiringOrganization: { name: "Acme Robotics" },
          },
        },
    });
    const x = await workday(
      { ...deps, now: () => NOW },
      {
        host: "acme.wd5.myworkdayjobs.com",
        tenant: "acme",
        site: "External",
        path: "job/Remote-US/Backend-Engineer_JR-1042",
        postingId: "acme/JR-1042",
      },
    );
    expect(x).toMatchObject({ atsPostingId: "acme/JR-1042" });
    expect(x?.fields).toMatchObject({
      title: "Backend Engineer",
      company: "Acme Robotics",
      remote: "remote",
      description: "Own the ledger service.",
      postedAt: new Date("2026-11-22T12:00:00Z"),
    });
  });

  it("works out the posting date only from exact relative phrases", () => {
    expect(postedOn("Posted Today", NOW)).toEqual(NOW);
    expect(postedOn("Posted Yesterday", NOW)).toEqual(new Date("2026-11-24T12:00:00Z"));
    expect(postedOn("Posted 30+ Days Ago", NOW)).toBeNull();
  });
});
