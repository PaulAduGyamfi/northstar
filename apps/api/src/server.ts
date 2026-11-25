import type { IncomingMessage, ServerResponse } from "node:http";
import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { authEndpoints, SESSION_COOKIE } from "./auth.js";
import type { ApiConfig } from "./config.js";
import type { AnyEndpoint } from "./endpoint.js";
import type { Sessions } from "./sessions.js";

// The API's request handling (NS-156): host, origin and content-type checks, routing, the
// session, input and output schemas, and one `api.request` span per request. Plain node:http,
// no framework: three endpoints don't need one, and every rule here is visible.

// The largest body read; anything bigger is refused before parsing.
export const MAX_BODY_BYTES = 16 * 1024;

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function createApi(deps: { config: ApiConfig; sessions: Sessions; extra?: AnyEndpoint[] }) {
  const endpoints = [...authEndpoints(deps.config, deps.sessions), ...(deps.extra ?? [])];
  const tracer = trace.getTracer("@northstar/api");
  // Loopback names only, on the API's own port: a page that rebinds its own DNS name to
  // 127.0.0.1 still sends its own name as Host, and is refused.
  const ownHosts = new Set([`127.0.0.1:${deps.config.port}`, `localhost:${deps.config.port}`]);

  return (req: IncomingMessage, res: ServerResponse): void => {
    void tracer.startActiveSpan("api.request", async (span) => {
      const method = req.method ?? "GET";
      span.setAttribute("http.request.method", method);
      try {
        const status = await handle(req, res, span);
        span.setAttribute("http.response.status_code", status);
      } catch (error) {
        // An error's name only: messages can quote input.
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.name : "Error",
        });
        span.setAttribute("http.response.status_code", 500);
        if (!res.headersSent) reply(res, 500, { error: "internal" });
      } finally {
        span.end();
      }
    });
  };

  async function handle(req: IncomingMessage, res: ServerResponse, span: Span): Promise<number> {
    if (!ownHosts.has(req.headers.host ?? "")) return reply(res, 421, { error: "misdirected" });
    // The query string never selects a route (no endpoint reads one yet).
    const path = (req.url ?? "/").split("?")[0] as string;
    const forPath = endpoints.filter((e) => e.path === path);
    if (forPath.length === 0) return reply(res, 404, { error: "not_found" });
    const ep = forPath.find((e) => e.method === req.method);
    if (!ep) return reply(res, 405, { error: "method_not_allowed" });
    span.setAttribute("http.route", ep.path);

    if (ep.method === "POST") {
      // Browsers send Origin on every cross-site POST; a request from the web app (through its
      // /api proxy) carries the web origin. A JSON content type can't be sent cross-site without
      // a preflight, which this API never answers.
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== deps.config.webOrigin) {
        return reply(res, 403, { error: "forbidden_origin" });
      }
      const type = req.headers["content-type"] ?? "";
      if (!/^application\/json(;|$)/.test(type)) {
        return reply(res, 415, { error: "unsupported_media_type" });
      }
    }

    const session = liveSession(req.headers.cookie);
    if (ep.auth === "session" && session === null) {
      return reply(res, 401, { error: "unauthenticated" });
    }

    let raw: unknown = {};
    if (ep.method === "POST") {
      const body = await readBody(req);
      if (body === null) return reply(res, 413, { error: "too_large" });
      try {
        raw = body.length === 0 ? {} : JSON.parse(body);
      } catch {
        return reply(res, 400, { error: "invalid_json" });
      }
    }
    const input = ep.input.safeParse(raw);
    if (!input.success) {
      // Where the input is wrong, never what it was.
      const paths = input.error.issues.map((i) => i.path.join("."));
      return reply(res, 400, { error: "invalid_input", paths });
    }

    const result = await ep.handler(input.data, { session, span });
    const cookies = result.cookies ?? [];
    if (!result.ok) return reply(res, result.status, { error: result.error }, cookies);
    const output = ep.output.safeParse(result.body);
    if (!output.success) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: "OutputSchemaMismatch" });
      return reply(res, 500, { error: "internal" });
    }
    return reply(res, 200, output.data, cookies);
  }

  // The session token from the cookie, if it is a live session.
  function liveSession(header: string | undefined): string | null {
    for (const part of (header ?? "").split(";")) {
      const [name, value] = part.trim().split("=", 2);
      if (name === SESSION_COOKIE && value !== undefined && TOKEN.test(value)) {
        return deps.sessions.isLive(value) ? value : null;
      }
    }
    return null;
  }
}

// The body as text, or null when it passes MAX_BODY_BYTES.
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) tooBig = true;
      else chunks.push(chunk);
    });
    req.on("end", () => resolve(tooBig ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function reply(res: ServerResponse, status: number, body: unknown, cookies: string[] = []): number {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  // Answers are about Paul's session: never cache them.
  res.setHeader("cache-control", "no-store");
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);
  res.end(JSON.stringify(body));
  return status;
}
