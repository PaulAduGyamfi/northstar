import type { CompanyDomains } from "@northstar/db";
import { describe, expect, it } from "vitest";
import { DOMAINS_USAGE, type DomainsCliDeps, domainsCommand } from "./domains-cli.js";

// `jobs domains` (NS-252) on fakes. Synthetic companies and domains only.

const ACME = "00000000-0000-4000-8000-0000000000c1";

function run(argv: string[], over: Partial<DomainsCliDeps> = {}) {
  const printed: string[] = [];
  const saves: unknown[][] = [];
  const companies: CompanyDomains[] = [
    { companyId: ACME, name: "Acme", domains: ["acme.example"] },
  ];
  const deps: DomainsCliDeps & { print: (line: string) => void } = {
    read: async () => companies,
    save: async (...args) => {
      saves.push(args);
      return { ok: true, value: { saved: true, domains: ["acme.example", "mail.acme.example"] } };
    },
    print: (line) => printed.push(line),
    ...over,
  };
  return { result: domainsCommand(deps, argv), printed, saves };
}

describe("jobs domains", () => {
  it("isn't a domains command without the word domains", async () => {
    expect(await run(["alerts"]).result).toBeNull();
  });

  it("lists each company with its id and domains", async () => {
    const r = run(["domains"]);
    expect(await r.result).toBe(0);
    expect(r.printed).toEqual([`Acme (${ACME}): acme.example`]);
  });

  it("adds a domain for a company and prints its domains now", async () => {
    const r = run(["domains", "add", ACME, "mail.acme.example"]);
    expect(await r.result).toBe(0);
    expect(r.saves).toEqual([[ACME, "mail.acme.example", "add"]]);
    expect(r.printed).toEqual([
      "Added. It applies to the next mail the link step reads.",
      "Domains now: acme.example, mail.acme.example",
    ]);
  });

  it("says when nothing changed", async () => {
    const r = run(["domains", "remove", ACME, "old.example"], {
      save: async () => ({ ok: true, value: { saved: false, domains: [] } }),
    });
    expect(await r.result).toBe(0);
    expect(r.printed).toEqual(["Already so; nothing changed.", "Domains now: none"]);
  });

  it("says why a change was refused and exits 1", async () => {
    const r = run(["domains", "add", ACME, "taken.example"], {
      save: async () => ({ ok: false, error: { kind: "ClaimedByOther", companyId: "x" } }),
    });
    expect(await r.result).toBe(1);
    expect(r.printed[0]).toContain("Another of your companies already has that domain");
  });

  it("prints its usage for anything else, saving nothing", async () => {
    const r = run(["domains", "add", ACME]);
    expect(await r.result).toBe(1);
    expect([r.printed, r.saves]).toEqual([[DOMAINS_USAGE], []]);
  });
});
