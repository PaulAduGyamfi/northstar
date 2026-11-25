// A fake Gmail REST API for tests: list (paged), get metadata and get full, plus scripted failures.
// Synthetic messages only; it never touches the network.

export type FakeMessage = {
  id: string;
  threadId: string;
  internalDate: string;
  headers: Record<string, string>;
  text?: string | undefined;
  html?: string | undefined;
};

// `body`: the JSON error Google sends with the status (default "{}").
type Failure = { status: number; retryAfter?: string; body?: string };

export function fakeGmail(
  messages: FakeMessage[],
  opts: { pageSize?: number; failures?: Failure[] } = {},
) {
  const requests: { url: string; authorization: string | null }[] = [];
  const failures = [...(opts.failures ?? [])];
  const pageSize = opts.pageSize ?? 500;
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({
      url: url.toString(),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    const failure = failures.shift();
    if (failure) {
      const headers = failure.retryAfter ? { "retry-after": failure.retryAfter } : undefined;
      return new Response(failure.body ?? "{}", { status: failure.status, headers });
    }
    if (url.pathname.startsWith("/gmail/v1/users/me/threads/")) {
      const thread = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      return Response.json({
        id: thread,
        messages: messages
          .filter((x) => x.threadId === thread)
          .map((x) => ({ id: x.id, threadId: x.threadId })),
      });
    }
    const path = url.pathname.replace("/gmail/v1/users/me/messages", "");
    if (path === "") {
      const start = Number(url.searchParams.get("pageToken") ?? "0");
      const page = messages.slice(start, start + pageSize);
      const next = start + pageSize < messages.length ? String(start + pageSize) : undefined;
      return Response.json({
        messages: page.map((m) => ({ id: m.id, threadId: m.threadId })),
        ...(next ? { nextPageToken: next } : {}),
      });
    }
    const m = messages.find((x) => `/${x.id}` === path);
    if (!m) return new Response("{}", { status: 404 });
    const format = url.searchParams.get("format");
    const headers = Object.entries(m.headers).map(([name, value]) => ({ name, value }));
    const parts = [
      ...(m.text !== undefined ? [{ mimeType: "text/plain", body: { data: b64(m.text) } }] : []),
      ...(m.html !== undefined ? [{ mimeType: "text/html", body: { data: b64(m.html) } }] : []),
    ];
    return Response.json({
      id: m.id,
      threadId: m.threadId,
      internalDate: String(Date.parse(m.internalDate)),
      payload:
        format === "full"
          ? { mimeType: "multipart/alternative", headers, parts }
          : { mimeType: "multipart/alternative", headers },
    });
  }) as typeof fetch;

  return { fetch: fetchFn, requests };
}
