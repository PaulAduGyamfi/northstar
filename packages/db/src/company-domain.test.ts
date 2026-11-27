import { CandidateId } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { companyDomain } from "./company-domain-schema.js";
import {
  isSharedDomain,
  normalizeDomain,
  readCompanyDomains,
  setCompanyDomain,
} from "./company-domain-write.js";
import type { Db } from "./db.js";
import { readLinkCandidates } from "./mail-link-write.js";
import { company, domainEvent } from "./schema.js";
import { createTestDb, seedApplication, sqlState } from "./test/pglite.js";

// A company's own mail domains, entered by Paul (NS-252). Synthetic companies and domains only.

const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";
const FK_VIOLATION = "23503";

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let companyId: string;
let applicationId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const seeded = await seedApplication(db, "submitted");
  candidateId = CandidateId.parse(seeded.candidateId);
  companyId = seeded.companyId;
  applicationId = seeded.applicationId;
});

afterEach(async () => {
  await close();
});

const add = (domain: string, id = companyId) =>
  setCompanyDomain(db, { candidateId, companyId: id, domain, action: "add" });
const remove = (domain: string, id = companyId) =>
  setCompanyDomain(db, { candidateId, companyId: id, domain, action: "remove" });

const otherCompany = async () => {
  const [row] = await db.insert(company).values({ candidateId, name: "Globex" }).returning();
  if (!row) throw new Error("no company row");
  return row.id;
};

const events = () =>
  db
    .select({ type: domainEvent.type, payload: domainEvent.payload, reason: domainEvent.reason })
    .from(domainEvent)
    .where(eq(domainEvent.aggregate, `company:${companyId}`));

describe("normalizeDomain", () => {
  it("lower-cases, trims and drops a trailing dot", () => {
    expect(normalizeDomain("  Mail.Example.COM. ")).toBe("mail.example.com");
  });

  it("refuses what isn't a plain domain", () => {
    expect(
      [
        "com",
        "https://example.com",
        "example.com/jobs",
        "jo@example.com",
        "exa mple.com",
        "-example.com",
        "exämple.com",
        "Kelvin.example.com",
        `${"a".repeat(250)}.com`,
      ].map(normalizeDomain),
    ).toEqual(Array(9).fill(null));
  });
});

describe("isSharedDomain", () => {
  it("names freemail, shared ATS and hosting domains, names under them, and bare public suffixes", () => {
    expect(
      [
        "gmail.com",
        "live.com",
        "greenhouse.io",
        "mail.greenhouse.io",
        "acme.github.io",
        "co.uk",
      ].map(isSharedDomain),
    ).toEqual(Array(6).fill(true));
  });

  it("leaves a company's own domain alone, including one under a public suffix", () => {
    expect(["acme.example", "acme.co.uk", "mail.acme.com"].map(isSharedDomain)).toEqual([
      false,
      false,
      false,
    ]);
  });
});

describe("setCompanyDomain and readCompanyDomains", () => {
  it("lists every company with no domains before Paul sets any", async () => {
    expect(await readCompanyDomains(db, candidateId)).toEqual([
      { companyId, name: "Example Corp", domains: [] },
    ]);
  });

  it("adds a domain once, and a second add of the same domain stores nothing", async () => {
    const first = await add("Mail.Example.com");
    const second = await add("mail.example.com");
    expect([first, second]).toEqual([
      { ok: true, value: { saved: true, domains: ["mail.example.com"] } },
      { ok: true, value: { saved: false, domains: ["mail.example.com"] } },
    ]);
    expect(await db.select().from(companyDomain)).toHaveLength(1);
  });

  it("removes a domain as a new row, and removing one it doesn't hold stores nothing", async () => {
    await add("example.com");
    await add("mail.example.com");
    const removed = await remove("example.com");
    const again = await remove("example.com");
    expect([removed, again]).toEqual([
      { ok: true, value: { saved: true, domains: ["mail.example.com"] } },
      { ok: true, value: { saved: false, domains: ["mail.example.com"] } },
    ]);
    expect(await db.select().from(companyDomain)).toHaveLength(3);
    expect((await readCompanyDomains(db, candidateId))[0]?.domains).toEqual(["mail.example.com"]);
  });

  it("can add a domain back after removing it", async () => {
    await add("example.com");
    await remove("example.com");
    await add("example.com");
    expect((await readCompanyDomains(db, candidateId))[0]?.domains).toEqual(["example.com"]);
  });

  it("refuses a domain another of Paul's companies holds, and stores nothing", async () => {
    const globex = await otherCompany();
    await add("globex.example.com", globex);
    expect(await add("globex.example.com")).toEqual({
      ok: false,
      error: { kind: "ClaimedByOther", companyId: globex },
    });
    expect(await db.select().from(companyDomain)).toHaveLength(1);
  });

  it("refuses a shared domain or a bare public suffix, and stores nothing", async () => {
    expect([await add("gmail.com"), await add("co.uk"), await add("acme.github.io")]).toEqual(
      Array(3).fill({ ok: false, error: { kind: "SharedDomain" } }),
    );
    expect(await db.select().from(companyDomain)).toHaveLength(0);
  });

  it("refuses a domain above or below one another company holds", async () => {
    const globex = await otherCompany();
    await add("globex.example", globex);
    expect([await add("mail.globex.example"), await add("example")]).toEqual([
      { ok: false, error: { kind: "ClaimedByOther", companyId: globex } },
      { ok: false, error: { kind: "InvalidDomain" } },
    ]);
    await add("talent.initech.example", globex);
    expect(await add("initech.example")).toEqual({
      ok: false,
      error: { kind: "ClaimedByOther", companyId: globex },
    });
  });

  it("refuses a bad domain and a company that isn't Paul's", async () => {
    const stranger = await seedApplication(db, "submitted");
    expect([await add("not a domain"), await add("example.com", stranger.companyId)]).toEqual([
      { ok: false, error: { kind: "InvalidDomain" } },
      { ok: false, error: { kind: "UnknownCompany" } },
    ]);
    expect(await db.select().from(companyDomain)).toHaveLength(0);
  });

  it("writes one event per change with ids only and a fixed sentence, never the domain", async () => {
    await add("example.com");
    await add("example.com");
    await remove("example.com");
    const rows = await events();
    expect(rows.map((r) => [r.type, r.reason])).toEqual([
      ["company.domain_added", "You added a mail domain for a company"],
      ["company.domain_removed", "You removed a mail domain from a company"],
    ]);
    expect(JSON.stringify(rows)).not.toContain("example.com");
  });
});

describe("the company_domain table", () => {
  it("refuses UPDATE, DELETE and TRUNCATE", async () => {
    await add("example.com");
    expect([
      await sqlState(db.execute(sql`UPDATE company_domain SET domain = 'other.example.com'`)),
      await sqlState(db.execute(sql`DELETE FROM company_domain`)),
      await sqlState(db.execute(sql`TRUNCATE company_domain`)),
    ]).toEqual([RESTRICT_VIOLATION, RESTRICT_VIOLATION, RESTRICT_VIOLATION]);
  });

  it("refuses a bad domain, action or source written directly", async () => {
    const insert = (domain: string, action: string, source: string) =>
      sqlState(db.insert(companyDomain).values({ candidateId, companyId, domain, action, source }));
    expect([
      await insert("com", "add", "paul"),
      await insert("Example.com", "add", "paul"),
      await insert("example.com", "replace", "paul"),
      await insert("example.com", "add", "ats_metadata"),
    ]).toEqual(Array(4).fill(CHECK_VIOLATION));
  });

  it("refuses another candidate's company", async () => {
    const stranger = await seedApplication(db, "submitted");
    expect(
      await sqlState(
        db.insert(companyDomain).values({
          candidateId,
          companyId: stranger.companyId,
          domain: "example.com",
          action: "add",
          source: "paul",
        }),
      ),
    ).toBe(FK_VIOLATION);
  });
});

describe("readLinkCandidates with stored domains", () => {
  it("gives an application its company's current domains", async () => {
    await add("mail.example.com");
    await add("example.com");
    const [c] = await readLinkCandidates(db, candidateId);
    expect([c?.applicationId, c?.companyDomains]).toEqual([
      applicationId,
      ["example.com", "mail.example.com"],
    ]);
  });

  it("gives no domains once Paul removed them", async () => {
    await add("example.com");
    await remove("example.com");
    const [c] = await readLinkCandidates(db, candidateId);
    expect(c?.companyDomains).toBeUndefined();
  });
});
