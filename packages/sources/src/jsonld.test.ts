import { describe, expect, it } from "vitest";
import { findJobPosting, fromJsonLd } from "./jsonld.js";
import { termsFor } from "./terms.js";

// A synthetic careers page with JobPosting JSON-LD (invented company).
const posting = {
  "@context": "https://schema.org",
  "@type": "JobPosting",
  title: "Staff Software Engineer",
  hiringOrganization: { "@type": "Organization", name: "Vandelay Industries" },
  jobLocation: {
    "@type": "Place",
    address: { addressLocality: "Chicago", addressRegion: "IL", addressCountry: "US" },
  },
  jobLocationType: "TELECOMMUTE",
  baseSalary: {
    "@type": "MonetaryAmount",
    currency: "USD",
    value: { "@type": "QuantitativeValue", minValue: 190000, maxValue: 230000, unitText: "YEAR" },
  },
  experienceLevel: "Staff",
  qualifications: "<ul><li>8+ years building distributed systems</li><li>Go</li></ul>",
  datePosted: "2026-11-21",
  url: "https://vandelay.example.com/careers/staff-swe/apply",
  description: "<p>Lead the <strong>import/export</strong> platform.</p>",
};
const page = (ld: unknown) =>
  `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body>…</body></html>`;

describe("fromJsonLd", () => {
  it("maps a JobPosting's fields as written", () => {
    expect(fromJsonLd(page(posting))).toEqual({
      method: "jsonld",
      ats: null,
      atsPostingId: null,
      fields: {
        title: "Staff Software Engineer",
        company: "Vandelay Industries",
        location: "Chicago, IL, US",
        remote: "remote",
        salaryMin: 190000,
        salaryMax: 230000,
        salaryCurrency: "USD",
        salaryPeriod: "year",
        seniority: "Staff",
        requirements: ["8+ years building distributed systems", "Go"],
        niceToHaves: [],
        applyUrl: "https://vandelay.example.com/careers/staff-swe/apply",
        ats: null,
        description: "Lead the import/export platform.",
        postedAt: new Date("2026-11-21T00:00:00Z"),
      },
    });
  });

  it("finds a JobPosting inside an @graph next to other types", () => {
    const graph = { "@context": "https://schema.org", "@graph": [{ "@type": "WebPage" }, posting] };
    expect(findJobPosting(page(graph))?.title).toBe("Staff Software Engineer");
  });

  it("skips a broken JSON-LD block and still reads a good one", () => {
    const html = `<script type="application/ld+json">{not json</script>${page(posting)}`;
    expect(fromJsonLd(html)?.fields.title).toBe("Staff Software Engineer");
  });

  it("leaves a field it can't read as null instead of guessing", () => {
    const bare = { "@type": "JobPosting", title: "Engineer" };
    expect(fromJsonLd(page(bare))?.fields).toMatchObject({
      title: "Engineer",
      company: null,
      location: null,
      salaryMin: null,
      postedAt: null,
    });
  });

  it("returns null for a page without a JobPosting", () => {
    expect(fromJsonLd(page({ "@type": "Organization", name: "Vandelay" }))).toBeNull();
    expect(fromJsonLd("<html><body>No data</body></html>")).toBeNull();
  });
});

describe("termsFor", () => {
  it("marks LinkedIn, Indeed and Glassdoor prohibited, including country sites", () => {
    for (const url of [
      "https://www.linkedin.com/jobs/view/123",
      "https://uk.indeed.com/viewjob?jk=1",
      "https://www.indeed.co.uk/viewjob?jk=1",
      "https://www.glassdoor.ca/job-listing/x",
    ]) {
      expect(termsFor(url).terms, url).toBe("prohibited");
    }
  });

  it("marks the ATS boards official-api and a company's own page public-feed", () => {
    expect(termsFor("https://boards.greenhouse.io/globex/jobs/1")).toEqual({
      source: "greenhouse",
      terms: "official-api",
    });
    expect(termsFor("https://globex.example.com/careers/1")).toEqual({
      source: "careers-page",
      terms: "public-feed",
    });
  });

  it("doesn't let a look-alike name pass as prohibited or as an ATS", () => {
    expect(termsFor("https://notlinkedin.com/jobs/1").terms).toBe("public-feed");
    expect(termsFor("https://linkedin.com.evil.example/jobs/1").terms).toBe("public-feed");
  });
});
