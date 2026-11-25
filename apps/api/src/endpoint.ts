import type { Span } from "@opentelemetry/api";
import type { z } from "zod";

// The one endpoint pattern (ADR-0005: typed REST with Zod). The server parses the body with
// `input` before the handler runs and checks the handler's body against `output` before it is
// sent, so neither side of an endpoint can drift from its schema.

export type Context = {
  // The session token from the cookie when it is live, else null.
  session: string | null;
  // The request's span, for attributes such as the sign-in outcome.
  span: Span;
};

// Cookies are part of the result so handlers stay plain functions with no response object.
export type Result<O> =
  | { ok: true; body: O; cookies?: string[] }
  | { ok: false; status: 400 | 401 | 403 | 404 | 429; error: string; cookies?: string[] };

export type Endpoint<I = unknown, O = unknown> = {
  method: "GET" | "POST";
  path: string;
  // "session": refused with 401 before the body is read unless Paul is signed in.
  // "extension": the same, unless the request carries the extension's own token (NS-128). The two
  // never stand in for each other.
  auth: "none" | "session" | "extension";
  // The largest body this endpoint reads, in bytes (server.ts's MAX_BODY_BYTES when unset).
  maxBodyBytes?: number;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  handler: (input: I, ctx: Context) => Promise<Result<O>>;
};

// Keeps the input and output types tied to their schemas at each definition.
export function endpoint<I, O>(e: Endpoint<I, O>): Endpoint<I, O> {
  return e;
}

// For the server's list of endpoints, where each has its own I and O.
// biome-ignore lint/suspicious/noExplicitAny: the list holds endpoints of different types; each is checked where it is defined.
export type AnyEndpoint = Endpoint<any, any>;
