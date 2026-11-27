import type { CompanyDomainRefusal, CompanyDomains } from "@northstar/db";

// `jobs domains`, `jobs domains add <company-id> <domain>` and `jobs domains remove <company-id>
// <domain>` (NS-252, #313): Paul's own list of each company's mail domains, which the mail-link
// step uses to link a verified sender's mail to that company's applications. Paul is the only
// source: nothing here takes a domain from a job page or its ATS.

export type DomainsCliDeps = {
  read: () => Promise<CompanyDomains[]>;
  save: (
    companyId: string,
    domain: string,
    action: "add" | "remove",
  ) => Promise<
    | { ok: true; value: { saved: boolean; domains: string[] } }
    | { ok: false; error: CompanyDomainRefusal }
  >;
};

export const DOMAINS_USAGE =
  "usage: jobs domains | jobs domains add <company-id> <domain> | jobs domains remove <company-id> <domain>";

const REFUSED: Record<CompanyDomainRefusal["kind"], string> = {
  InvalidDomain: "That isn't a plain mail domain (such as mail.example.com). Nothing was saved.",
  SharedDomain:
    "That domain is shared by many senders (freemail, an ATS, a hosting service or a public suffix), so it can't be one company's own. Nothing was saved.",
  UnknownCompany: "No company of yours has that id (see jobs domains). Nothing was saved.",
  ClaimedByOther:
    "Another of your companies already has that domain, so it would pick both. Nothing was saved.",
};

// Returns null when the arguments aren't a `jobs domains` command, so the caller prints its usage.
export async function domainsCommand(
  deps: DomainsCliDeps & { print: (line: string) => void },
  argv: string[],
): Promise<number | null> {
  const [command, action, companyId, domain, ...extra] = argv;
  if (command !== "domains") return null;
  if (action === undefined) return show(deps);
  if ((action === "add" || action === "remove") && companyId && domain && extra.length === 0) {
    const result = await deps.save(companyId, domain, action);
    if (!result.ok) {
      deps.print(REFUSED[result.error.kind]);
      return 1;
    }
    const verb = action === "add" ? "Added" : "Removed";
    deps.print(
      result.value.saved
        ? `${verb}. It applies to the next mail the link step reads.`
        : "Already so; nothing changed.",
    );
    deps.print(`Domains now: ${result.value.domains.join(", ") || "none"}`);
    return 0;
  }
  deps.print(DOMAINS_USAGE);
  return 1;
}

async function show(deps: DomainsCliDeps & { print: (line: string) => void }): Promise<number> {
  const companies = await deps.read();
  if (companies.length === 0)
    deps.print("No companies yet. One appears with the first job you add.");
  for (const c of companies) {
    deps.print(`${c.name} (${c.companyId}): ${c.domains.join(", ") || "no mail domains yet"}`);
  }
  return 0;
}
