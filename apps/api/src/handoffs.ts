import type { HandoffOutcome, HandoffView, Resolved, ResolveError } from "@northstar/db";
import type { Result } from "@northstar/domain";
import { z } from "zod";
import { type AnyEndpoint, endpoint } from "./endpoint.js";

// "Needs your hands" (NS-121, APPLY-006, ACC-007): the applications a CAPTCHA, sign-in or
// verification step stopped, and Paul's word on what he did with each. Both need his session: an
// outcome of "submitted" moves his application. bin.ts wires packages/db, tests fake it.

export type HandoffPorts = {
  listOpen: () => Promise<HandoffView[]>;
  resolve: (handoffId: string, outcome: HandoffOutcome) => Promise<Result<Resolved, ResolveError>>;
  // needs_human → submitted through transitionApplication under this key; ok on a replay.
  markSubmitted: (applicationId: string, idempotencyKey: string) => Promise<{ ok: boolean }>;
};

// The key for Paul's "I submitted it": one per handoff, so a retried click never moves twice.
export const handoffSubmittedKey = (applicationId: string, handoffId: string) =>
  `application:${applicationId}:handoff:${handoffId}:submitted`;

// Only an https link is ever handed to the page (the database refuses anything else too).
const HttpsUrl = z.string().regex(/^https:\/\/[^\s]+$/);

const Handoffs = z.object({
  items: z.array(
    z.object({
      handoffId: z.string(),
      applicationId: z.string(),
      ats: z.string(),
      reason: z.string(),
      applyUrl: HttpsUrl,
      createdAt: z.string(),
    }),
  ),
});

const Resolve = z.object({
  handoffId: z.uuid(),
  outcome: z.enum(["submitted", "gave_up"]),
});

export function handoffEndpoints(ports: HandoffPorts): AnyEndpoint[] {
  const list = endpoint({
    method: "GET",
    path: "/handoffs",
    auth: "session",
    input: z.object({}),
    output: Handoffs,
    handler: async () => {
      const open = await ports.listOpen();
      return {
        ok: true,
        body: {
          items: open.map((h) => ({
            handoffId: h.handoffId,
            applicationId: h.applicationId,
            ats: h.ats,
            reason: h.reason,
            applyUrl: h.applyUrl,
            createdAt: h.createdAt.toISOString(),
          })),
        },
      };
    },
  });

  const resolve = endpoint({
    method: "POST",
    path: "/handoffs/resolve",
    auth: "session",
    input: Resolve,
    output: z.object({ outcome: z.enum(["submitted", "gave_up"]), replayed: z.boolean() }),
    handler: async ({ handoffId, outcome }) => {
      const r = await ports.resolve(handoffId, outcome);
      if (!r.ok && r.error.kind === "NotFound")
        return { ok: false, status: 404, error: "not_found" };
      // "I submitted it" for an application no longer waiting on Paul: nothing is stored, and the
      // handoff stays open so he can say "I gave up" instead.
      if (!r.ok) return { ok: false, status: 409, error: "not_needs_human" };
      // The stored outcome decides, not this request's: a "gave up" can't be turned into a
      // submission by a second click. A replay retries the move under the same key, so a move
      // that failed the first time (a 500) is finished by sending the click again.
      if (r.value.outcome === "submitted") {
        const key = handoffSubmittedKey(r.value.applicationId, handoffId);
        const moved = await ports.markSubmitted(r.value.applicationId, key);
        if (!moved.ok) throw new Error("handoff: application status move failed");
      }
      return { ok: true, body: { outcome: r.value.outcome, replayed: r.value.replayed } };
    },
  });

  return [list, resolve];
}
