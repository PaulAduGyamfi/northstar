import type { DeadLetterView } from "@northstar/db";
import { z } from "zod";
import { type AnyEndpoint, endpoint } from "./endpoint.js";

// The dead-letter view (NS-215, RES-007): work that exhausted its retries, behind Paul's session,
// and his retry, skip or hand-off. A letter's subject is left out: it names a row, which the page
// has no use for. bin.ts wires packages/db's store, tests fake it.

const ACTIONS = ["retry", "skip", "hand_off"] as const;

export type DeadLetterPorts = {
  list: () => Promise<DeadLetterView[]>;
  resolve: (input: {
    deadLetterId: string;
    action: (typeof ACTIONS)[number];
    actor: "user";
  }) => Promise<
    | { ok: true; value: { kind: string; subject: string } }
    | { ok: false; error: { kind: "NotFound" } | { kind: "AlreadyResolved" } }
  >;
};

const Letter = z.object({
  deadLetterId: z.string(),
  kind: z.string(),
  reasonCode: z.string(),
  attempts: z.number(),
  deadAt: z.string(),
});

const Resolve = z.object({
  deadLetterId: z.string().uuid(),
  action: z.enum(ACTIONS),
});

export function deadLetterEndpoints(ports: DeadLetterPorts): AnyEndpoint[] {
  const list = endpoint({
    method: "GET",
    path: "/dead-letters",
    auth: "session",
    input: z.object({}),
    output: z.object({ items: z.array(Letter) }),
    handler: async () => {
      try {
        const letters = await ports.list();
        return {
          ok: true,
          body: {
            // Fields picked by name: the subject never leaves the server.
            items: letters.map((l) => ({
              deadLetterId: l.deadLetterId,
              kind: l.kind,
              reasonCode: l.reasonCode,
              attempts: l.attempts,
              deadAt: l.deadAt.toISOString(),
            })),
          },
        };
      } catch {
        return { ok: false, status: 503, error: "unavailable" };
      }
    },
  });

  const resolve = endpoint({
    method: "POST",
    path: "/dead-letters/resolve",
    auth: "session",
    input: Resolve,
    output: z.object({ kind: z.string(), action: z.enum(ACTIONS) }),
    handler: async ({ deadLetterId, action }) => {
      try {
        // Only Paul's signed-in path reaches this, so the resolution is his, whatever the body says.
        const r = await ports.resolve({ deadLetterId, action, actor: "user" });
        if (!r.ok) {
          return r.error.kind === "NotFound"
            ? { ok: false, status: 404, error: "not_found" }
            : { ok: false, status: 409, error: "already_resolved" };
        }
        return { ok: true, body: { kind: r.value.kind, action } };
      } catch {
        return { ok: false, status: 503, error: "unavailable" };
      }
    },
  });

  return [list, resolve];
}
