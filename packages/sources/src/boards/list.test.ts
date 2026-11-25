import { describe, expect, it } from "vitest";
import { fakeWeb } from "../test/fake-web.js";
import { BoardUnavailable, listBoard } from "./list.js";

// Synthetic board responses shaped like each ATS's public JSON (invented companies and ids).
const LEVER_ID = "0c9a4b1e-1111-4222-8333-444455556666";
const ASHBY_ID = "7d2e9f30-aaaa-4bbb-8ccc-ddddeeeeffff";

const GH =
  "https://boards-api.greenhouse.io/v1/boards/globex/jobs?content=true&pay_transparency=true";
const LEVER = "https://api.lever.co/v0/postings/initech?mode=json";
const ASHBY = "https://api.ashbyhq.com/posting-api/job-board/hooli?includeCompensation=true";
const SR = "https://api.smartrecruiters.com/v1/companies/Acme/postings?limit=100";
const WORKABLE = "https://apply.workable.com/api/v1/widget/accounts/umbrella?details=true";

describe("listBoard", () => {
  it("maps a Greenhouse board to postings with ids, canonical links and fields", async () => {
    const { deps } = fakeWeb({
      [GH]: {
        body: {
          jobs: [
            {
              id: 4012345,
              title: "Backend Engineer",
              company_name: "Globex",
              absolute_url: "https://globex.example.com/careers?gh_jid=4012345",
              location: { name: "Remote - US" },
              content: "&lt;p&gt;Build APIs.&lt;/p&gt;",
              first_published: "2026-11-25T11:40:00Z",
            },
          ],
        },
      },
    });
    const [p] = await listBoard(deps, { ats: "greenhouse", board: "globex" });
    expect(p?.url).toBe("https://boards.greenhouse.io/globex/jobs/4012345");
    expect(p?.extraction).toMatchObject({ ats: "greenhouse", atsPostingId: "4012345" });
    expect(p?.extraction.fields).toMatchObject({
      title: "Backend Engineer",
      company: "Globex",
      remote: "remote",
      description: "Build APIs.",
      postedAt: new Date("2026-11-25T11:40:00Z"),
    });
  });

  it("maps a Lever board, the company being the board slug", async () => {
    const { deps } = fakeWeb({
      [LEVER]: {
        body: [{ id: LEVER_ID, text: "Platform Engineer", createdAt: 1764070800000 }],
      },
    });
    const [p] = await listBoard(deps, { ats: "lever", board: "initech" });
    expect(p?.url).toBe(`https://jobs.lever.co/initech/${LEVER_ID}`);
    expect(p?.extraction.atsPostingId).toBe(LEVER_ID);
    expect(p?.extraction.fields.company).toBe("initech");
  });

  it("maps an Ashby board", async () => {
    const { deps } = fakeWeb({
      [ASHBY]: { body: { jobs: [{ id: ASHBY_ID.toUpperCase(), title: "Data Engineer" }] } },
    });
    const [p] = await listBoard(deps, { ats: "ashby", board: "hooli" });
    expect(p?.url).toBe(`https://jobs.ashbyhq.com/hooli/${ASHBY_ID}`);
    expect(p?.extraction.atsPostingId).toBe(ASHBY_ID);
  });

  it("maps a SmartRecruiters board, with its released date and location", async () => {
    const { deps } = fakeWeb({
      [SR]: {
        body: {
          totalFound: 1,
          content: [
            {
              id: "744000012345678",
              name: "Site Reliability Engineer",
              releasedDate: "2026-11-25T10:00:00.000Z",
              company: { name: "Acme Corp" },
              location: { city: "Austin", region: "TX", country: "us", remote: false },
              experienceLevel: { label: "Mid-Senior Level" },
            },
          ],
        },
      },
    });
    const [p] = await listBoard(deps, { ats: "smartrecruiters", board: "Acme" });
    expect(p?.url).toBe("https://jobs.smartrecruiters.com/Acme/744000012345678");
    expect(p?.extraction).toMatchObject({
      ats: "smartrecruiters",
      atsPostingId: "744000012345678",
    });
    expect(p?.extraction.fields).toMatchObject({
      title: "Site Reliability Engineer",
      company: "Acme Corp",
      location: "Austin, TX, US",
      remote: "onsite",
      seniority: "Mid-Senior Level",
      postedAt: new Date("2026-11-25T10:00:00.000Z"),
    });
  });

  it("maps a Workable board, with its description and remote flag", async () => {
    const { deps } = fakeWeb({
      [WORKABLE]: {
        body: {
          name: "Umbrella",
          jobs: [
            {
              title: "Frontend Engineer",
              shortcode: "A1B2C3D4E5",
              telecommuting: true,
              city: "Denver",
              state: "Colorado",
              country: "United States",
              published_on: "2026-11-24",
              description: "<p>Ship the web app.</p>",
            },
          ],
        },
      },
    });
    const [p] = await listBoard(deps, { ats: "workable", board: "umbrella" });
    expect(p?.url).toBe("https://apply.workable.com/umbrella/j/A1B2C3D4E5");
    expect(p?.extraction).toMatchObject({ ats: "workable", atsPostingId: "umbrella/A1B2C3D4E5" });
    expect(p?.extraction.fields).toMatchObject({
      title: "Frontend Engineer",
      company: "Umbrella",
      location: "Denver, Colorado, United States",
      remote: "remote",
      description: "Ship the web app.",
      postedAt: new Date("2026-11-24T00:00:00Z"),
    });
  });

  it("scopes Workable ids by the account in lower case, whatever case the board was typed in", async () => {
    const { deps } = fakeWeb({
      "https://apply.workable.com/api/v1/widget/accounts/Umbrella?details=true": {
        body: { jobs: [{ title: "QA", shortcode: "ZZ11" }] },
      },
    });
    const [p] = await listBoard(deps, { ats: "workable", board: "Umbrella" });
    expect(p?.extraction.atsPostingId).toBe("umbrella/ZZ11");
  });

  it("an empty board is an empty list, not a failure", async () => {
    const { deps } = fakeWeb({ [GH]: { body: { jobs: [] } } });
    expect(await listBoard(deps, { ats: "greenhouse", board: "globex" })).toEqual([]);
  });

  it("a board that answers an error status throws BoardUnavailable with the status", async () => {
    const { deps } = fakeWeb({ [LEVER]: { status: 503, body: "busy" } });
    await expect(listBoard(deps, { ats: "lever", board: "initech" })).rejects.toThrow(
      new BoardUnavailable("the board answered 503"),
    );
  });

  it("a board whose JSON changed shape throws BoardUnavailable instead of storing junk", async () => {
    const { deps } = fakeWeb({ [ASHBY]: { body: { postings: [] } } });
    await expect(listBoard(deps, { ats: "ashby", board: "hooli" })).rejects.toThrow(
      new BoardUnavailable("the board's response didn't have the expected shape"),
    );
  });

  it("odd character codes in a posting decode safely instead of failing the board", async () => {
    const { deps } = fakeWeb({
      [GH]: {
        body: {
          jobs: [
            { id: 1, title: "Engineer &#99999999;", content: "a&#0;b &#xD800; c" },
            { id: 2, title: "Designer" },
          ],
        },
      },
    });
    const list = await listBoard(deps, { ats: "greenhouse", board: "globex" });
    expect(list.map((p) => p.extraction.fields.title)).toEqual([
      "Engineer &#99999999;",
      "Designer",
    ]);
    expect(list[0]?.extraction.fields.description).toBe("a&#0;b &#xD800; c");
  });

  it("skips postings whose ids aren't the ATS's id shape, so a link can't be bent", async () => {
    const { deps } = fakeWeb({
      [LEVER]: {
        body: [
          { id: "../other-co/x", text: "Bent" },
          { id: LEVER_ID.toUpperCase(), text: "Platform Engineer" },
        ],
      },
    });
    const list = await listBoard(deps, { ats: "lever", board: "initech" });
    expect(list.map((p) => [p.url, p.extraction.atsPostingId])).toEqual([
      [`https://jobs.lever.co/initech/${LEVER_ID}`, LEVER_ID],
    ]);
  });

  it("reads at most 2,000 postings from one board", async () => {
    const many = Array.from({ length: 2_005 }, (_, i) => ({ id: i + 1, title: `Role ${i}` }));
    const { deps } = fakeWeb({ [GH]: { body: { jobs: many } } });
    expect(await listBoard(deps, { ats: "greenhouse", board: "globex" })).toHaveLength(2_000);
  });

  it("skips one malformed posting and keeps the rest", async () => {
    const { deps } = fakeWeb({
      [LEVER]: {
        body: [{ text: "no id" }, { id: LEVER_ID, text: "Platform Engineer" }],
      },
    });
    const list = await listBoard(deps, { ats: "lever", board: "initech" });
    expect(list.map((p) => p.extraction.atsPostingId)).toEqual([LEVER_ID]);
  });
});
