import { describe, expect, it } from "vitest";
import { readSession, todayView } from "./session";

// The Today page's guard against fake API answers. Never a real network call.
const API = "http://127.0.0.1:8787";
const TOKEN = "A".repeat(43);

type Call = { url: string; headers: Headers };

function fakeFetch(answer: Response | Error) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    if (answer instanceof Error) throw answer;
    return answer;
  }) as typeof fetch;
  return { fn, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("readSession", () => {
  it("is signed in when the API answers /me with Paul", async () => {
    const f = fakeFetch(json(200, { user: "paul" }));
    expect(await readSession({ apiOrigin: API, token: TOKEN, fetch: f.fn })).toEqual({
      kind: "signed_in",
      user: "paul",
    });
  });

  it("forwards only the session cookie, to the API's /me", async () => {
    const f = fakeFetch(json(200, { user: "paul" }));
    await readSession({ apiOrigin: API, token: TOKEN, fetch: f.fn });
    expect(f.calls.map((c) => [c.url, c.headers.get("cookie")])).toEqual([
      [`${API}/me`, `ns_session=${TOKEN}`],
    ]);
  });

  it("is signed out without asking the API when there is no cookie", async () => {
    const f = fakeFetch(json(200, { user: "paul" }));
    expect(await readSession({ apiOrigin: API, token: undefined, fetch: f.fn })).toEqual({
      kind: "signed_out",
    });
    expect(f.calls).toEqual([]);
  });

  it("is signed out when the API answers 401", async () => {
    const f = fakeFetch(json(401, { error: "unauthenticated" }));
    expect(await readSession({ apiOrigin: API, token: TOKEN, fetch: f.fn })).toEqual({
      kind: "signed_out",
    });
  });

  it("is unreachable when the API is down", async () => {
    const f = fakeFetch(new TypeError("fetch failed"));
    expect(await readSession({ apiOrigin: API, token: TOKEN, fetch: f.fn })).toEqual({
      kind: "unreachable",
    });
  });

  it("is unreachable, not signed in, when the API answers 200 with something else", async () => {
    const f = fakeFetch(json(200, { user: "someone" }));
    expect(await readSession({ apiOrigin: API, token: TOKEN, fetch: f.fn })).toEqual({
      kind: "unreachable",
    });
  });

  it("is unreachable on a server error", async () => {
    const f = fakeFetch(json(500, { error: "internal" }));
    expect(await readSession({ apiOrigin: API, token: TOKEN, fetch: f.fn })).toEqual({
      kind: "unreachable",
    });
  });

  it("never forwards a malformed cookie value", async () => {
    const f = fakeFetch(json(200, { user: "paul" }));
    expect(await readSession({ apiOrigin: API, token: "x; other=1", fetch: f.fn })).toEqual({
      kind: "signed_out",
    });
    expect(f.calls).toEqual([]);
  });
});

describe("todayView", () => {
  it("redirects a signed-out visitor to sign-in", () => {
    expect(todayView({ kind: "signed_out" })).toEqual({ redirect: "/sign-in" });
  });

  it("shows the unreachable notice, never the page, when the API is down", () => {
    expect(todayView({ kind: "unreachable" })).toEqual({ render: "unreachable" });
  });

  it("renders Today for Paul", () => {
    expect(todayView({ kind: "signed_in", user: "paul" })).toEqual({ render: "today" });
  });
});
