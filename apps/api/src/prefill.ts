import { createHash, randomBytes } from "node:crypto";
import type { HandoffPackage, HandoffPackageError } from "@northstar/db";
import { ApplicationPackage, type Result } from "@northstar/domain";
import { z } from "zod";
import { type AnyEndpoint, endpoint } from "./endpoint.js";

// The handoff pre-fill's read (NS-192 slice 2, ADR-0029 option 2, APPLY-006). The extension may
// read one open handoff's approved package only with a one-time grant that Paul's own session
// issued for that handoff in the last 2 minutes: the extension token alone reads nothing
// (ADR-0019's "no reads" holds outside those 2 minutes). The package is re-checked by
// readHandoffPackage at the moment of each read. No grant, field value, contact detail or URL ever
// goes into a span, log or error: refusals are fixed codes.

// How long a grant may be used, and how many may wait at once (oldest dropped first).
export const GRANT_TTL_MS = 2 * 60_000;
const MAX_GRANTS = 20;
// Room for a handoff id and a grant in JSON, nothing more.
const PACKAGE_MAX_BODY = 512;

// The fixed outcome code on the api.request span: never a grant, id or value.
const OUTCOME = "northstar.prefill.outcome";
// When the event write throws: the error's class name only, never its message (NS-192 slice 5).
const RECORD_ERROR = "northstar.prefill.record_error";

// A plain class name ("DatabaseError"), or "Error" for anything else, so nothing the error carries
// in its message or a crafted name reaches the span.
export function errorClassOf(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "Error";
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// Grants in memory, like sessions and passkey challenges: a restart forgets them, which only means
// Paul clicks again. Only each grant's SHA-256 is kept, bound to its handoff.
export function createPrefillGrants(now: () => number) {
  const live = new Map<string, { handoffId: string; expiresAt: number }>();
  return {
    issue(handoffId: string): { grant: string; expiresAt: number } {
      const grant = randomBytes(32).toString("base64url");
      // Expired grants go first, so they never push out a live one.
      for (const [key, g] of live) if (now() >= g.expiresAt) live.delete(key);
      if (live.size >= MAX_GRANTS) {
        const oldest = live.keys().next().value;
        if (oldest !== undefined) live.delete(oldest);
      }
      const expiresAt = now() + GRANT_TTL_MS;
      live.set(sha256(grant), { handoffId, expiresAt });
      return { grant, expiresAt };
    },
    // Used up whatever the answer: a grant tried for another handoff can't be tried again.
    consume(grant: string, handoffId: string): boolean {
      const key = sha256(grant);
      const found = live.get(key);
      live.delete(key);
      return found !== undefined && now() < found.expiresAt && found.handoffId === handoffId;
    },
    // The stored keys (each grant's SHA-256): tests check that nothing but hashes is kept.
    keys(): string[] {
      return [...live.keys()];
    },
  };
}

export type PrefillGrants = ReturnType<typeof createPrefillGrants>;

export type PrefillPorts = {
  // readHandoffPackage for the candidate (bin.ts wires packages/db; tests fake it).
  readPackage: (handoffId: string) => Promise<Result<HandoffPackage, HandoffPackageError>>;
  // Writes handoff.prefilled (recordHandoffPrefill, NS-192 slice 3): true once it is stored.
  recordPrefill: (input: {
    handoffId: string;
    applicationId: string;
    ats: HandoffPackage["ats"];
    fieldCount: number;
    grantKey: string;
  }) => Promise<boolean>;
  grants: PrefillGrants;
};

// readHandoffPackage's refusals as fixed codes and statuses (ADR-0029).
const REFUSAL: Record<HandoffPackageError["kind"], { status: 404 | 409; error: string }> = {
  NotFound: { status: 404, error: "not_found" },
  Closed: { status: 409, error: "closed" },
  NoPackage: { status: 409, error: "no_package" },
  NotApproved: { status: 409, error: "not_approved" },
  Changed: { status: 409, error: "changed" },
};

// 32 random bytes, base64url.
const Grant = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

const PrefillPackage = z.object({
  handoffId: z.uuid(),
  applicationId: z.uuid(),
  ats: ApplicationPackage.shape.ats,
  applyUrl: ApplicationPackage.shape.applyUrl,
  contact: ApplicationPackage.shape.contact,
  fields: ApplicationPackage.shape.fields,
});

export function prefillEndpoints(ports: PrefillPorts): AnyEndpoint[] {
  // Paul's click on the "Needs your hands" card: a grant for one handoff the read would serve.
  const grant = endpoint({
    method: "POST",
    path: "/handoffs/prefill-grant",
    auth: "session",
    input: z.object({ handoffId: z.uuid() }),
    output: z.object({ grant: Grant, expiresAt: z.string() }),
    handler: async ({ handoffId }, { span }) => {
      const pkg = await ports.readPackage(handoffId);
      if (!pkg.ok) {
        span.setAttribute(OUTCOME, REFUSAL[pkg.error.kind].error);
        return { ok: false, ...REFUSAL[pkg.error.kind] };
      }
      const issued = ports.grants.issue(handoffId);
      span.setAttribute(OUTCOME, "issued");
      return {
        ok: true,
        body: { grant: issued.grant, expiresAt: new Date(issued.expiresAt).toISOString() },
      };
    },
  });

  // The extension's read: its token and a live grant for this handoff, then the package as it is now.
  const read = endpoint({
    method: "POST",
    path: "/handoffs/package",
    auth: "extension",
    maxBodyBytes: PACKAGE_MAX_BODY,
    // A missing grant reaches the check below (as ""), so it is grant_invalid like any wrong one.
    input: z.object({ handoffId: z.uuid(), grant: z.string().max(100).optional() }),
    output: PrefillPackage,
    handler: async ({ handoffId, grant: given }, { span }) => {
      // The grant first: without it nothing is read, so a leaked token alone learns nothing.
      if (!ports.grants.consume(given ?? "", handoffId)) {
        span.setAttribute(OUTCOME, "grant_invalid");
        return { ok: false, status: 403, error: "grant_invalid" };
      }
      const pkg = await ports.readPackage(handoffId);
      if (!pkg.ok) {
        span.setAttribute(OUTCOME, REFUSAL[pkg.error.kind].error);
        return { ok: false, ...REFUSAL[pkg.error.kind] };
      }
      const p = pkg.value;
      // The pre-fill is in the feed before the package leaves (ADR-0029, OBS-001), keyed by this
      // grant so a retry stores one event. If it can't be written, nothing is served; the grant
      // is already used, so Paul clicks again.
      const recorded = await ports
        .recordPrefill({
          handoffId: p.handoffId,
          applicationId: p.applicationId,
          ats: p.ats,
          fieldCount: Object.keys(p.fields).length,
          grantKey: sha256(given ?? "").slice(0, 16),
        })
        .catch((error: unknown) => {
          span.setAttribute(RECORD_ERROR, errorClassOf(error));
          return false;
        });
      if (!recorded) {
        span.setAttribute(OUTCOME, "prefill_unrecorded");
        return { ok: false, status: 503, error: "prefill_unrecorded" };
      }
      span.setAttribute(OUTCOME, "served");
      // Field by field: never spread a row into a response.
      return {
        ok: true,
        body: {
          handoffId: p.handoffId,
          applicationId: p.applicationId,
          ats: p.ats,
          applyUrl: p.applyUrl,
          contact: p.contact,
          fields: p.fields,
        },
      };
    },
  });

  return [grant, read];
}
