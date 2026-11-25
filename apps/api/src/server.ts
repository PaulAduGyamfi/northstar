import type { IncomingMessage, ServerResponse } from "node:http";
import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { authEndpoints, SESSION_COOKIE } from "./auth.js";
import type { ApiConfig } from "./config.js";
import type { AnyEndpoint } from "./endpoint.js";
import { keyMatches, type Sessions } from "./sessions.js";

// The API's request handling (NS-156): host, origin and content-type checks, routing, the
// session, input and output schemas, and one `api.request` span per request. Plain node:http,
// no framework: three endpoints don't need one, and every rule here is visible.

// The largest body read; anything bigger is refused before parsing.
export const MAX_BODY_BYTES = 16 * 1024;

// A session token as sessions.ts makes it (32 random bytes, base64url). Any other cookie value is
// treated as no session without hashing or looking it up.
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

// An extension's Origin: Chrome extension ids are 32 letters a to p. Any installed extension can
// send one, so it is a filter, not the check: the extension token is (NS-128).
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
// The longest Bearer value worth hashing; anything longer is refused unread.
const MAX_BEARER = 512;

export function createApi(deps: {
  config: ApiConfig;
  sessions: Sessions;
  // The extension token's SHA-256 (config.ts loadExtensionTokenHash); null refuses the extension.
  extensionTokenSha256?: string | null;
  extra?: AnyEndpoint[];
}) {
  const endpoints = [...authEndpoints(deps.config, deps.sessions), ...(deps.extra ?? [])];
  const tracer = trace.getTracer("@northstar/api");
  // Loopback names only, on the API's own port: a page that rebinds its own DNS name to
  // 127.0.0.1 still sends its own name as Host, and is refused.
  const ownHosts = new Set([`127.0.0.1:${deps.config.port}`, `localhost:${deps.config.port}`]);
  // The web app proxies /api/* with its own Host replaced by ours (Next's changeOrigin), and the
  // browser's Host moved to x-forwarded-host. That must be the web app's own host, or a page
  // whose name was rebound to 127.0.0.1 could reach the API through the proxy.
  const webHost = new URL(deps.config.webOrigin).host;

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
    const forwarded = req.headers["x-forwarded-host"];
    if (forwarded !== undefined && forwarded !== webHost) {
      return reply(res, 421, { error: "misdirected" });
    }
    // The query string never selects a route; a GET endpoint reads it as its input.
    const [path = "/", query = ""] = (req.url ?? "/").split("?", 2);
    const forPath = endpoints.filter((e) => e.path === path);
    if (forPath.length === 0) return reply(res, 404, { error: "not_found" });
    const ep = forPath.find((e) => e.method === req.method);
    if (!ep) return reply(res, 405, { error: "method_not_allowed" });
    span.setAttribute("http.route", ep.path);

    // The extension calls the API directly, from its own chrome-extension:// origin, whatever the
    // method.
    if (ep.auth === "extension" && !EXTENSION_ORIGIN.test(req.headers.origin ?? "")) {
      return reply(res, 403, { error: "forbidden_origin" });
    }
    if (ep.method === "POST") {
      // Browsers send Origin on every POST made with fetch or a form, and the web app's own
      // (through its /api proxy) carry the web origin. A POST without one isn't from Paul's
      // browser page, so it is refused too. A JSON content type can't be sent cross-site without
      // a preflight, which this API never answers.
      if (ep.auth !== "extension" && req.headers.origin !== deps.config.webOrigin) {
        return reply(res, 403, { error: "forbidden_origin" });
      }
      const type = req.headers["content-type"] ?? "";
      if (!/^application\/json(;|$)/.test(type)) {
        return reply(res, 415, { error: "unsupported_media_type" });
      }
    }

    // Each kind of credential opens only its own endpoints: the cookie isn't even read for an
    // extension endpoint, and the extension token is never checked for a session one.
    const session = ep.auth === "extension" ? null : liveSession(req.headers.cookie);
    if (ep.auth === "session" && session === null) {
      return reply(res, 401, { error: "unauthenticated" });
    }
    if (ep.auth === "extension") {
      // Wrong tokens share sign-in's limit: 5 a minute across both, then every try waits.
      if (deps.sessions.throttled()) {
        span.setAttribute("northstar.auth.outcome", "throttled");
        return reply(res, 429, { error: "throttled" });
      }
      const ok = extensionTokenOk(req.headers.authorization);
      span.setAttribute("northstar.auth.outcome", ok ? "extension_ok" : "extension_refused");
      if (!ok) {
        deps.sessions.recordFailure();
        return reply(res, 401, { error: "unauthenticated" });
      }
    }

    // A GET's input is its query string, checked by the endpoint's schema like a body.
    let raw: unknown = ep.method === "GET" ? Object.fromEntries(new URLSearchParams(query)) : {};
    if (ep.method === "POST") {
      const body = await readBody(req, ep.maxBodyBytes ?? MAX_BODY_BYTES);
      if (body === null) {
        // Not read to the end: answer now and close the connection.
        res.setHeader("connection", "close");
        return reply(res, 413, { error: "too_large" });
      }
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

  // Does the Bearer token hash to the configured extension token? Constant time.
  function extensionTokenOk(header: string | undefined): boolean {
    const hash = deps.extensionTokenSha256 ?? null;
    if (hash === null || header === undefined || !header.startsWith("Bearer ")) return false;
    const token = header.slice("Bearer ".length);
    return token.length > 0 && token.length <= MAX_BEARER && keyMatches(token, hash);
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

// The body as text, or null when it passes the endpoint's limit.
function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) {
        chunks.push(chunk);
        return;
      }
      // Stop reading at once: a client can't hold the connection by sending more.
      req.off("data", onData);
      req.pause();
      resolve(null);
    };
    req.on("data", onData);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
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
