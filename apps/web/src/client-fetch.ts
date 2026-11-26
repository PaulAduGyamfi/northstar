// The web app's browser calls to its own API (/api/*, rewritten to the API) with a time limit
// (RES-005, NS-176): a request that hangs ends in the caller's existing "couldn't reach" message
// instead of a spinner that never stops. Plain setTimeout, so tests can drive it.
export const CLIENT_TIMEOUT_MS = 15_000;

export function apiFetch(
  path: string,
  init: RequestInit = {},
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("timed out", "TimeoutError")),
    CLIENT_TIMEOUT_MS,
  );
  return fetchFn(path, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// A request that ran out of time may still have reached the API and done its work: say so, never
// "nothing was done" (a decision Paul doesn't see would pass its undo window unseen).
export const TIMED_OUT_MESSAGE =
  "No answer in time. It may have gone through: reload the page to see where things stand.";

export const isTimeout = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "TimeoutError";
