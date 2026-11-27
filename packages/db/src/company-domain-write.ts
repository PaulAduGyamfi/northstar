import type { CandidateId } from "@northstar/domain";
import { and, asc, eq, sql } from "drizzle-orm";
import { companyDomain } from "./company-domain-schema.js";
import type { Db } from "./db.js";
import { appendEvent, inSpan } from "./resilience-event.js";
import { company } from "./schema.js";

// A company's own mail domains (NS-252, #313): the only writer and reader of company_domain.
// Paul enters them; nothing here learns one from mail.

// The same shape as the table's CHECK, so a bad input is a typed refusal, never a database error.
const DOMAIN_SHAPE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

// A domain as stored: trimmed, lower case, any trailing dot dropped. Null when it isn't one
// (no dot, a scheme, a path, an address, a space, a non-ASCII letter or over 253 characters).
export function normalizeDomain(raw: string): string | null {
  // Only printable ASCII before lower-casing: toLowerCase folds some other characters (the
  // Kelvin sign) into ASCII letters, so a lookalike could otherwise pass as a plain domain.
  const trimmed = raw.trim();
  if (!/^[\x21-\x7e]+$/.test(trimmed)) return null;
  const domain = trimmed.toLowerCase().replace(/\.$/, "");
  return domain.length >= 3 && domain.length <= 253 && DOMAIN_SHAPE.test(domain) ? domain : null;
}

export type CompanyDomainRefusal =
  | { kind: "InvalidDomain" }
  | { kind: "UnknownCompany" }
  // Another of Paul's companies holds this domain now: one domain never picks two companies.
  | { kind: "ClaimedByOther"; companyId: string };

export type CompanyDomains = { companyId: string; name: string; domains: string[] };

type Reader = Pick<Db, "select">;

// Each company's current domains: per company and domain, the newest row is an `add`. Every one
// of Paul's companies is listed, with no domains when he hasn't set any; ordered by name, then id.
export async function readCompanyDomains(
  db: Reader,
  candidateId: CandidateId,
): Promise<CompanyDomains[]> {
  const companies = await db
    .select({ id: company.id, name: company.name })
    .from(company)
    .where(eq(company.candidateId, candidateId))
    .orderBy(asc(company.name), asc(company.id));
  const rows = await db
    .select({
      companyId: companyDomain.companyId,
      domain: companyDomain.domain,
      action: companyDomain.action,
    })
    .from(companyDomain)
    .where(eq(companyDomain.candidateId, candidateId))
    .orderBy(asc(companyDomain.position));
  // Later rows overwrite earlier ones, so each key ends at its newest action.
  const current = new Map<string, Map<string, string>>();
  for (const r of rows) {
    const byDomain = current.get(r.companyId) ?? new Map<string, string>();
    byDomain.set(r.domain, r.action);
    current.set(r.companyId, byDomain);
  }
  return companies.map((c) => ({
    companyId: c.id,
    name: c.name,
    domains: [...(current.get(c.id) ?? new Map())]
      .filter(([, action]) => action === "add")
      .map(([domain]) => domain)
      .sort(),
  }));
}

// Adds or removes one domain for one of Paul's companies, with a `company.domain_added` or
// `company.domain_removed` event. Adding a domain the company holds, or removing one it doesn't,
// stores nothing.
export async function setCompanyDomain(
  db: Db,
  input: {
    candidateId: CandidateId;
    companyId: string;
    domain: string;
    action: "add" | "remove";
  },
): Promise<
  | { ok: true; value: { saved: boolean; domains: string[] } }
  | { ok: false; error: CompanyDomainRefusal }
> {
  const domain = normalizeDomain(input.domain);
  if (domain === null) return { ok: false, error: { kind: "InvalidDomain" } };
  try {
    return await inSpan("company.domain_set", { "northstar.domain.action": input.action }, (span) =>
      db.transaction(async (tx) => {
        // The candidate's row lock serializes changes: two adds racing for one domain on two
        // companies could otherwise both pass the claimed-by-other check.
        await tx.execute(sql`select id from candidate where id = ${input.candidateId} for update`);
        const [owned] = await tx
          .select({ id: company.id })
          .from(company)
          .where(and(eq(company.id, input.companyId), eq(company.candidateId, input.candidateId)));
        if (!owned) return { ok: false, error: { kind: "UnknownCompany" } } as const;
        const all = await readCompanyDomains(tx, input.candidateId);
        const held = all.find((c) => c.companyId === input.companyId)?.domains ?? [];
        if (input.action === "add") {
          const other = all.find(
            (c) => c.companyId !== input.companyId && c.domains.includes(domain),
          );
          if (other) {
            return {
              ok: false,
              error: { kind: "ClaimedByOther", companyId: other.companyId },
            } as const;
          }
        }
        const present = held.includes(domain);
        span.setAttribute("northstar.domain.changed", present !== (input.action === "add"));
        if (present === (input.action === "add")) {
          return { ok: true, value: { saved: false, domains: held } } as const;
        }
        const [row] = await tx
          .insert(companyDomain)
          .values({
            candidateId: input.candidateId,
            companyId: input.companyId,
            domain,
            action: input.action,
            source: "paul",
          })
          .returning({ id: companyDomain.id, createdAt: companyDomain.createdAt });
        if (!row) throw new Error("company_domain insert returned no row");
        const added = input.action === "add";
        await appendEvent(tx, span, {
          candidateId: input.candidateId,
          aggregate: `company:${input.companyId}`,
          type: added ? "company.domain_added" : "company.domain_removed",
          actor: "user",
          // Fixed words only: the feed shows this sentence.
          reason: added
            ? "You added a mail domain for a company"
            : "You removed a mail domain from a company",
          // Ids only: the domain itself stays in its own table.
          payload: { companyId: input.companyId, changeId: row.id },
          idempotencyKey: `company_domain:${row.id}`,
          at: row.createdAt,
        });
        const domains = added ? [...held, domain].sort() : held.filter((d) => d !== domain);
        return { ok: true, value: { saved: true, domains } } as const;
      }),
    );
  } catch {
    // A fresh error with no cause: the driver's message lists the query's parameters.
    throw new Error("company.domain_set failed");
  }
}
