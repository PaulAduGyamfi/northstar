import type { DedupeCandidate, JobFields, JobSourceInput, SaveResult } from "@northstar/db";
import type { CallRecord, LlmGateway, LlmOutcome } from "@northstar/llm";
import { describe, expect, it } from "vitest";
import { findDuplicate, samePlace, similarity } from "./dedupe.js";
import { emptyFields } from "./extraction.js";
import { type IngestDeps, ingestText, ingestUrl } from "./ingest.js";
import { jobExtractRoute } from "./job-extract-route.js";
import type { JobExtract } from "./job-extract-schema.js";
import { fakeWeb, type Page } from "./test/fake-web.js";

// Synthetic postings only (invented companies, .example hosts).
const GH_API =
  "https://boards-api.greenhouse.io/v1/boards/globex/jobs/4012345?pay_transparency=true";
const GH_URL = "https://boards.greenhouse.io/globex/jobs/4012345";
const DESCRIPTION =
  "Globex is hiring a backend engineer to build payment APIs and the ledger services that move money between accounts every day.";
const ghPosting = {
  id: 4012345,
  title: "Backend Engineer",
  company_name: "Globex",
  absolute_url: GH_URL,
  location: { name: "Remote - US" },
  content: `&lt;p&gt;${DESCRIPTION}&lt;/p&gt;`,
};
const careersPage = (title = "Backend Engineer") =>
  `<html><head><script type="application/ld+json">${JSON.stringify({
    "@type": "JobPosting",
    title,
    hiringOrganization: { name: "Globex" },
    jobLocation: { address: { addressLocality: "Remote - US", addressCountry: "United States" } },
    description: `<p>${DESCRIPTION}</p>`,
  })}</script></head></html>`;

const record: CallRecord = {
  route: "job-extract",
  promptId: "job-extract",
  promptVersion: 1,
  modelRequested: "claude-opus-5-5",
  modelServed: "claude-opus-5-5",
  effort: "low",
  inputTokens: 2000,
  outputTokens: 200,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  latencyMs: 2000,
  costUsd: 0.01,
  stopReason: "end_turn",
  refusalCategory: null,
  fallbackUsed: false,
};

// An in-memory store with the database's rules: same URL or ATS posting is unchanged; mergeInto
// adds a source; otherwise a new job.
function memoryStore() {
  const jobs: (DedupeCandidate & { fields: JobFields })[] = [];
  const saves: { fields: JobFields; source: JobSourceInput; mergeInto: string | null }[] = [];
  return {
    jobs,
    saves,
    candidates: async () => jobs.map(({ fields: _f, ...c }) => ({ ...c, sources: [...c.sources] })),
    save: async (input: {
      fields: JobFields;
      source: JobSourceInput;
      mergeInto: string | null;
    }): Promise<SaveResult> => {
      saves.push(input);
      const { source } = input;
      const same = jobs.find((j) =>
        j.sources.some(
          (s) =>
            s.url === source.url ||
            (source.atsPostingId !== null &&
              s.ats === source.ats &&
              s.atsPostingId === source.atsPostingId),
        ),
      );
      if (same) return { status: "unchanged", jobId: same.jobId };
      const entry = { url: source.url, ats: source.ats, atsPostingId: source.atsPostingId };
      const target = jobs.find((j) => j.jobId === input.mergeInto);
      if (target) {
        target.sources.push(entry);
        return { status: "merged", jobId: target.jobId };
      }
      const jobId = `job-${jobs.length + 1}`;
      const f = input.fields;
      jobs.push({
        jobId,
        company: f.company,
        title: f.title,
        location: f.location,
        description: f.description,
        sources: [entry],
        fields: f,
      });
      return { status: "created", jobId };
    },
  };
}

function setup(pages: Record<string, Page>, answer?: LlmOutcome<JobExtract>) {
  const web = fakeWeb(pages, ["intranet.example"]);
  const store = memoryStore();
  const calls: unknown[] = [];
  const gateway = {
    call: (async (_route: unknown, input: unknown) => {
      calls.push(input);
      if (!answer) throw new Error("no model call expected");
      return answer;
    }) as LlmGateway["call"],
  };
  const deps: IngestDeps = {
    ...web.deps,
    now: () => new Date("2026-11-25T12:00:00Z"),
    gateway,
    route: jobExtractRoute(),
    store,
  };
  return { deps, store, asked: web.asked, calls };
}

const ok = (output: Partial<JobExtract>): LlmOutcome<JobExtract> => ({
  kind: "Ok",
  record,
  output: {
    isJobPosting: true,
    title: null,
    company: null,
    location: null,
    remote: null,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    salaryPeriod: null,
    seniority: null,
    requirements: [],
    niceToHaves: [],
    postedText: null,
    ...output,
  },
});

describe("ingestUrl", () => {
  it("reads a Greenhouse link through its API, with no model call", async () => {
    const { deps, store, calls } = setup({ [GH_API]: { body: ghPosting } });
    const r = await ingestUrl(deps, `${GH_URL}?gh_src=newsletter`);
    expect(r).toMatchObject({ status: "created", method: "ats_api", missing: [] });
    expect(store.saves[0]?.source).toEqual({
      url: GH_URL,
      method: "ats_api",
      ats: "greenhouse",
      atsPostingId: "4012345",
    });
    expect(calls).toEqual([]);
  });

  it("a pasted SmartRecruiters link is read from its page but stored with its ATS posting id", async () => {
    const url = "https://jobs.smartrecruiters.com/Acme/744000012345678-site-reliability-engineer";
    const { deps, store, asked } = setup({ [url]: { body: careersPage() } });
    expect(await ingestUrl(deps, url)).toMatchObject({ status: "created", method: "jsonld" });
    expect(store.saves[0]?.source).toEqual({
      url,
      method: "jsonld",
      ats: "smartrecruiters",
      atsPostingId: "744000012345678",
    });
    // No API client for it: only the page itself was asked for.
    expect(asked).toEqual([url]);
  });

  it("reads a careers page's JSON-LD with no model call", async () => {
    const url = "https://globex.example/careers/backend";
    const { deps, calls } = setup({ [url]: { body: careersPage() } });
    expect(await ingestUrl(deps, url)).toMatchObject({ status: "created", method: "jsonld" });
    expect(calls).toEqual([]);
  });

  it("falls back to the model for a page with no structure, dropping what the page lacks", async () => {
    const url = "https://initech.example/jobs/platform";
    const { deps, store } = setup(
      { [url]: { body: "<h1>Platform Engineer</h1><p>Initech, Austin TX</p>" } },
      ok({ title: "Platform Engineer", company: "Initech", seniority: "Senior" }),
    );
    const r = await ingestUrl(deps, url);
    expect(r).toMatchObject({
      status: "created",
      method: "model",
      dropped: ["seniority"],
      missing: [],
    });
    expect(store.saves[0]?.fields).toMatchObject({
      title: "Platform Engineer",
      company: "Initech",
      seniority: null,
    });
  });

  it("stores a draft naming what's missing when the model can't find a title or company", async () => {
    const url = "https://careers.example/job/77";
    const { deps } = setup(
      { [url]: { body: "<p>Senior Data Scientist</p>" } },
      ok({ title: "Senior Data Scientist" }),
    );
    expect(await ingestUrl(deps, url)).toMatchObject({ status: "created", missing: ["company"] });
  });

  it("stores an empty draft when the model refuses, never a silent drop", async () => {
    const url = "https://careers.example/job/78";
    const { deps, store } = setup(
      { [url]: { body: "<p>Some posting</p>" } },
      { kind: "Refused", category: null, record },
    );
    expect(await ingestUrl(deps, url)).toMatchObject({
      status: "created",
      missing: ["title", "company"],
    });
    expect(store.saves[0]?.fields.title).toBeNull();
  });

  it("stores nothing for a page the model says isn't one job", async () => {
    const url = "https://vandelay.example/careers";
    const { deps, store } = setup(
      { [url]: { body: "<ul><li>Many jobs</li></ul>" } },
      ok({ isJobPosting: false }),
    );
    expect(await ingestUrl(deps, url)).toEqual({ status: "not_a_job", record });
    expect(store.saves).toEqual([]);
  });

  it("falls through to the page when the ATS API is too big to read", async () => {
    const id = "7d2e9f30-aaaa-4bbb-8ccc-ddddeeeeffff";
    const url = `https://jobs.ashbyhq.com/globex/${id}`;
    const { deps, store } = setup({
      "https://api.ashbyhq.com/posting-api/job-board/globex?includeCompensation=true": {
        contentLength: String(3 * 1024 * 1024),
        body: "{}",
      },
      [url]: { body: careersPage() },
    });
    expect(await ingestUrl(deps, url)).toMatchObject({ status: "created", method: "jsonld" });
    expect(store.saves[0]?.source).toMatchObject({ ats: "ashby", atsPostingId: id });
  });

  it("refuses LinkedIn, Indeed, Glassdoor, YC and Work at a Startup links without any network call", async () => {
    const { deps, asked } = setup({});
    for (const url of [
      "https://www.linkedin.com/jobs/view/1",
      "https://www.indeed.com/viewjob?jk=1",
      "https://www.glassdoor.co.uk/job-listing/x",
      "https://lnkd.in/abc123",
      "https://www.ycombinator.com/companies/globex/jobs/abc123-backend-engineer",
      "https://ycombinator.com/jobs",
      "https://www.workatastartup.com/jobs/12345",
    ]) {
      expect((await ingestUrl(deps, url)).status).toBe("refused");
    }
    expect(asked).toEqual([]);
  });

  it("tells Paul to save a Work at a Startup posting himself and use jobs add --text (NS-288)", async () => {
    const { deps } = setup({});
    expect(await ingestUrl(deps, "https://www.workatastartup.com/jobs/12345")).toEqual({
      status: "refused",
      reason:
        "www.workatastartup.com doesn't allow automated reading; save the description to a file and use jobs add --text",
    });
  });

  it("refuses a link to a private address with the fetcher's reason", async () => {
    const { deps } = setup({});
    expect(await ingestUrl(deps, "https://intranet.example/jobs/1")).toEqual({
      status: "refused",
      reason: "intranet.example resolves to a private or local address",
    });
  });

  it("adding the same link twice fetches nothing the second time and changes nothing", async () => {
    const { deps, store, asked } = setup({ [GH_API]: { body: ghPosting } });
    const first = await ingestUrl(deps, GH_URL);
    const before = asked.length;
    const second = await ingestUrl(deps, GH_URL);
    expect(second).toMatchObject({
      status: "unchanged",
      jobId: first.status === "created" ? first.jobId : "",
    });
    expect(asked.length).toBe(before);
    expect(store.jobs).toHaveLength(1);
  });

  it("the same role from Greenhouse and the company's careers page is one job with two sources", async () => {
    const careers = "https://globex.example/careers/backend";
    const { deps, store } = setup({
      [GH_API]: { body: ghPosting },
      [careers]: { body: careersPage() },
    });
    await ingestUrl(deps, GH_URL);
    expect(await ingestUrl(deps, careers)).toMatchObject({ status: "merged" });
    expect(store.jobs).toHaveLength(1);
    expect(store.jobs[0]?.sources).toHaveLength(2);
  });

  it("a different role at the same company stays its own job", async () => {
    const careers = "https://globex.example/careers/data";
    const { deps, store } = setup({
      [GH_API]: { body: ghPosting },
      [careers]: { body: careersPage("Data Engineer") },
    });
    await ingestUrl(deps, GH_URL);
    expect((await ingestUrl(deps, careers)).status).toBe("created");
    expect(store.jobs).toHaveLength(2);
  });
});

describe("apply links", () => {
  const ld = (url: string) =>
    `<script type="application/ld+json">${JSON.stringify({
      "@type": "JobPosting",
      title: "Backend Engineer",
      hiringOrganization: { name: "Globex" },
      url,
    })}</script>`;

  it("resolves a relative apply link against the page", async () => {
    const page = "https://globex.example/careers/backend";
    const { deps, store } = setup({ [page]: { body: ld("/careers/backend/apply") } });
    await ingestUrl(deps, page);
    expect(store.saves[0]?.fields.applyUrl).toBe("https://globex.example/careers/backend/apply");
  });

  it("drops a javascript: apply link instead of failing the whole job", async () => {
    const page = "https://globex.example/careers/evil";
    const { deps, store } = setup({ [page]: { body: ld("javascript:alert(1)") } });
    expect((await ingestUrl(deps, page)).status).toBe("created");
    expect(store.saves[0]?.fields.applyUrl).toBeNull();
  });
});

describe("ingestText", () => {
  it("reads a saved LinkedIn description through the model and keeps the link it came from", async () => {
    const text = "Backend Engineer\nGlobex\nRemote - US";
    const { deps, store, asked } = setup({}, ok({ title: "Backend Engineer", company: "Globex" }));
    const r = await ingestText(deps, "https://www.linkedin.com/jobs/view/123?trk=x", text);
    expect(r).toMatchObject({ status: "created", method: "text" });
    expect(store.saves[0]?.source.url).toBe("https://www.linkedin.com/jobs/view/123");
    expect(asked).toEqual([]);
  });

  it("still takes a Work at a Startup posting Paul saved himself, fetching nothing (NS-288)", async () => {
    const text = "Backend Engineer\nGlobex\nRemote - US";
    const { deps, store, asked } = setup({}, ok({ title: "Backend Engineer", company: "Globex" }));
    const r = await ingestText(deps, "https://www.workatastartup.com/jobs/12345", text);
    expect([r.status, store.saves[0]?.source.url, asked]).toEqual([
      "created",
      "https://www.workatastartup.com/jobs/12345",
      [],
    ]);
  });
});

describe("findDuplicate", () => {
  const fields = {
    ...emptyFields(),
    title: "Backend Engineer",
    company: "Globex Inc.",
    location: "Remote - US",
    description: DESCRIPTION,
  };
  const existing: DedupeCandidate[] = [
    {
      jobId: "j1",
      company: "Globex",
      title: "Backend Engineer",
      location: "Remote - US",
      description: DESCRIPTION,
      sources: [{ url: GH_URL, ats: "greenhouse", atsPostingId: "4012345" }],
    },
  ];
  const source = (url: string): JobSourceInput => ({
    url,
    method: "jsonld",
    ats: null,
    atsPostingId: null,
  });

  it("matches the same company, title and location with a description over the threshold", () => {
    expect(findDuplicate(existing, fields, source("https://globex.example/x"))).toEqual({
      jobId: "j1",
      by: "content",
    });
  });

  it("doesn't match on content when the description differs", () => {
    const other = {
      ...fields,
      description:
        "A completely different role writing marketing copy for our blog and social channels.",
    };
    expect(findDuplicate(existing, other, source("https://globex.example/x"))).toBeNull();
  });

  it("never matches on content when a part is missing", () => {
    expect(
      findDuplicate(existing, { ...fields, description: null }, source("https://globex.example/x")),
    ).toBeNull();
  });

  it("matches the same ATS posting first, whatever the content", () => {
    const s: JobSourceInput = {
      url: "https://other.example/x",
      method: "ats_api",
      ats: "greenhouse",
      atsPostingId: "4012345",
    };
    expect(findDuplicate(existing, { ...emptyFields() }, s)).toEqual({
      jobId: "j1",
      by: "ats_posting",
    });
  });
});

describe("samePlace", () => {
  it("treats a longer spelling of the same place, or a missing one, as the same", () => {
    expect(samePlace("San Francisco, CA", "San Francisco, CA, US")).toBe(true);
    expect(samePlace(null, "Austin, TX")).toBe(true);
  });

  it("keeps different places apart", () => {
    expect(samePlace("Austin, TX", "Dallas, TX")).toBe(false);
  });
});

describe("similarity", () => {
  it("is 1 for the same text and 0 for nothing shared", () => {
    expect(similarity(DESCRIPTION, DESCRIPTION)).toBe(1);
    expect(similarity(DESCRIPTION, "entirely unrelated words here now")).toBe(0);
  });
});
