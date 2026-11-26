import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch, CLIENT_TIMEOUT_MS } from "./client-fetch";

// The web app's browser calls (NS-176, RES-005). A fake fetch; no network.
afterEach(() => {
  vi.useRealTimers();
});

describe("apiFetch", () => {
  it("passes the request through with its init", async () => {
    const seen: [string, RequestInit | undefined][] = [];
    const fake = (async (path: string, init?: RequestInit) => {
      seen.push([path, init]);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const res = await apiFetch("/api/feed", { method: "POST" }, fake);
    expect([res.status, seen[0]?.[0], seen[0]?.[1]?.method]).toEqual([200, "/api/feed", "POST"]);
  });

  it("aborts a request that hangs past CLIENT_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    const hanging = ((_: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const call = apiFetch("/api/feed", {}, hanging);
    const result = expect(call).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(CLIENT_TIMEOUT_MS);
    await result;
  });
});
