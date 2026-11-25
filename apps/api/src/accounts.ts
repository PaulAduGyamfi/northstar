import type { TenantView } from "@northstar/db";
import { ACCOUNT_STATUSES } from "@northstar/domain";
import { z } from "zod";
import { type AnyEndpoint, endpoint } from "./endpoint.js";

// Paul's employer accounts (NS-124, ACC-001): each tenant and its account status, for Settings →
// Accounts. Needs his session. It never returns the account email, a URL or anything from the
// vault: the list is built field by field, never spread.

export type AccountsPorts = { listTenants: () => Promise<TenantView[]> };

const Accounts = z.object({
  items: z.array(
    z.object({
      tenantKey: z.string(),
      ats: z.string(),
      status: z.enum(ACCOUNT_STATUSES),
      createdAt: z.string(),
      changedAt: z.string().nullable(),
    }),
  ),
});

export function accountsEndpoints(ports: AccountsPorts): AnyEndpoint[] {
  const list = endpoint({
    method: "GET",
    path: "/accounts",
    auth: "session",
    input: z.object({}),
    output: Accounts,
    handler: async () => {
      let tenants: TenantView[];
      try {
        tenants = await ports.listTenants();
      } catch {
        // The registry can't be read (Postgres down): the page says so.
        return { ok: false, status: 503, error: "unavailable" };
      }
      return {
        ok: true,
        body: {
          items: tenants.map((t) => ({
            tenantKey: t.tenantKey,
            ats: t.ats,
            status: t.status,
            createdAt: t.createdAt.toISOString(),
            changedAt: t.changedAt?.toISOString() ?? null,
          })),
        },
      };
    },
  });
  return [list];
}
