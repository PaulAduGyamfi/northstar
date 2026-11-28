import type { PushSubscriptionInput, RemoveResult, SubscribeResult } from "@northstar/db";
import { endpointAllowed } from "@northstar/domain";
import { z } from "zod";
import { type AnyEndpoint, endpoint } from "./endpoint.js";

// Web push subscriptions (NS-193 slice 2, ADR-0032 item 5), behind Paul's session only: a
// subscription receives his notifications, so only his signed-in browser may add or remove one.
// The endpoint must be one of the push services the sender allows (endpointAllowed) before it is
// stored. Responses carry counts and flags, never an endpoint or key. bin.ts wires packages/db,
// tests fake it.

export type PushPorts = {
  // The VAPID public key, or null while push isn't set up.
  publicKey: string | null;
  count: () => Promise<number>;
  subscribe: (input: PushSubscriptionInput) => Promise<SubscribeResult>;
  unsubscribe: (endpoint: string) => Promise<RemoveResult>;
};

// A subscription as PushSubscription.toJSON() gives it.
const Subscribe = z.object({
  endpoint: z.string().max(1024),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
});

const Unsubscribe = z.object({ endpoint: z.string().max(1024) });

export function pushEndpoints(ports: PushPorts): AnyEndpoint[] {
  const key = endpoint({
    method: "GET",
    path: "/push/key",
    auth: "session",
    input: z.object({}),
    output: z.object({ publicKey: z.string().nullable(), subscriptions: z.number().nullable() }),
    handler: async () => {
      let subscriptions: number | null;
      try {
        subscriptions = await ports.count();
      } catch {
        // An unreadable count says so (null); it never reads as "no browsers".
        subscriptions = null;
      }
      return { ok: true, body: { publicKey: ports.publicKey, subscriptions } };
    },
  });

  const subscribe = endpoint({
    method: "POST",
    path: "/push/subscribe",
    auth: "session",
    input: Subscribe,
    output: z.object({ created: z.boolean() }),
    handler: async ({ endpoint: url, keys }) => {
      // No key means push isn't set up: storing a subscription nothing can use helps no one.
      if (ports.publicKey === null) return { ok: false, status: 409, error: "push_not_set_up" };
      if (!endpointAllowed(url)) return { ok: false, status: 400, error: "endpoint_not_allowed" };
      try {
        const r = await ports.subscribe({ endpoint: url, p256dh: keys.p256dh, auth: keys.auth });
        if (r.ok) return { ok: true, body: { created: r.created } };
        return { ok: false, status: 400, error: `invalid_${r.error.field}` };
      } catch {
        return { ok: false, status: 503, error: "unavailable" };
      }
    },
  });

  const unsubscribe = endpoint({
    method: "POST",
    path: "/push/unsubscribe",
    auth: "session",
    input: Unsubscribe,
    output: z.object({ removed: z.boolean() }),
    handler: async ({ endpoint: url }) => {
      try {
        return { ok: true, body: { removed: (await ports.unsubscribe(url)).removed } };
      } catch {
        return { ok: false, status: 503, error: "unavailable" };
      }
    },
  });

  return [key, subscribe, unsubscribe];
}
