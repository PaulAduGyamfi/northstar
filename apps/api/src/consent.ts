import type { ConsentRecordView } from "@northstar/db";
import { CONSENT_POLICIES, type ConsentPolicy, NOTICE_KINDS } from "@northstar/domain";
import { z } from "zod";
import { type AnyEndpoint, endpoint } from "./endpoint.js";

// Paul's consent policy and the notices accepted for him (NS-198, ACC-008), for Settings →
// Accounts. Every endpoint needs his session, and a policy change is always his (actor `user`,
// setConsentPolicy). The list gives each notice's tenant, kind, https link and time; its text is
// read one notice at a time, on his request. bin.ts wires packages/db, tests fake it.

export type ConsentPorts = {
  readPolicy: () => Promise<ConsentPolicy>;
  setPolicy: (policy: ConsentPolicy) => Promise<void>;
  listConsents: () => Promise<ConsentRecordView[]>;
  readConsentText: (recordId: string) => Promise<string | null>;
};

const Policy = z.object({ policy: z.enum(CONSENT_POLICIES) });

const Consents = z.object({
  items: z.array(
    z.object({
      recordId: z.string(),
      tenantKey: z.string(),
      kind: z.enum(NOTICE_KINDS),
      // The database only stores https links; checked again so the page can link it safely.
      noticeUrl: z.string().regex(/^https:\/\/[^\s]+$/),
      acceptedAt: z.string(),
    }),
  ),
});

// A failed read (Postgres down) is the page's "can't be read right now", never a 500.
const unavailable = { ok: false, status: 503, error: "unavailable" } as const;

export function consentEndpoints(ports: ConsentPorts): AnyEndpoint[] {
  const readPolicy = endpoint({
    method: "GET",
    path: "/settings/consent-policy",
    auth: "session",
    input: z.object({}),
    output: Policy,
    handler: async () => {
      try {
        return { ok: true, body: { policy: await ports.readPolicy() } };
      } catch {
        return unavailable;
      }
    },
  });

  const setPolicy = endpoint({
    method: "POST",
    path: "/settings/consent-policy",
    auth: "session",
    // Only the policy is read from the body: nothing in it can name who made the change.
    input: Policy,
    output: Policy,
    handler: async ({ policy }) => {
      try {
        await ports.setPolicy(policy);
      } catch {
        return unavailable;
      }
      return { ok: true, body: { policy } };
    },
  });

  const list = endpoint({
    method: "GET",
    path: "/accounts/consents",
    auth: "session",
    input: z.object({}),
    output: Consents,
    handler: async () => {
      let rows: ConsentRecordView[];
      try {
        rows = await ports.listConsents();
      } catch {
        return unavailable;
      }
      return {
        ok: true,
        // Field by field, never spread: a read that carried the text couldn't leak it here.
        body: {
          items: rows.map((r) => ({
            recordId: r.recordId,
            tenantKey: r.tenantKey,
            kind: r.kind,
            noticeUrl: r.noticeUrl,
            acceptedAt: r.acceptedAt.toISOString(),
          })),
        },
      };
    },
  });

  const text = endpoint({
    method: "GET",
    path: "/accounts/consents/text",
    auth: "session",
    input: z.object({ recordId: z.uuid() }),
    output: z.object({ text: z.string() }),
    handler: async ({ recordId }) => {
      let found: string | null;
      try {
        found = await ports.readConsentText(recordId);
      } catch {
        return unavailable;
      }
      if (found === null) return { ok: false, status: 404, error: "not_found" };
      return { ok: true, body: { text: found } };
    },
  });

  return [readPolicy, setPolicy, list, text];
}
