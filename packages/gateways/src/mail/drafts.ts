import type { CallOutcome } from "@northstar/domain";
import type { Span } from "@opentelemetry/api";
import { bearerOf, type GmailComposeAccess } from "./access.js";
import { type DraftGuard, DraftHeldBack, DraftRequestError, DraftWriteError } from "./errors.js";
import { APPROVAL_HEADER } from "./message.js";

// The Gmail draft writer's requests (NS-237 slice 4, ADR-0025). Private to src/mail/: a boundary
// test fails if anything else imports it. Gmail's `drafts.create` is its only write, and one
// thread read finds a draft an unknown outcome left. It never sends: no URL here names one, and
// the allowlist below refuses any other request whatever the code around it becomes.

const DRAFTS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/drafts";
const THREADS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/threads";
// Gmail's ids: thread and message ids are hex, draft ids may hold letters, digits, `_` and `-`.
const GMAIL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const THREAD_QUERY = `?format=metadata&metadataHeaders=${APPROVAL_HEADER}`;
// Every character of the constants is escaped, so only Gmail's own host and this exact query match.
const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const THREAD_READ = new RegExp(`^${literal(THREADS_URL)}/[0-9a-f]{8,32}${literal(THREAD_QUERY)}$`);

// The breaker every Gmail call goes through, and this writer's own kill switch (ADR-0007).
export const DRAFTS_DEPENDENCY = "gmail";
export const DRAFTS_SUBSYSTEM = "gmail_drafts";
const TIMEOUT_MS = 30_000;

// Whether a request is one the writer may send: create a draft with a body whose only key is
// `message`, holding only `raw` and `threadId`; or read one thread's marker headers.
export function requestAllowed(method: string, url: string, body: unknown): boolean {
  if (url === DRAFTS_URL) {
    if (method !== "POST" || typeof body !== "string") return false;
    try {
      const parsed: unknown = JSON.parse(body);
      if (!isPlainObject(parsed) || !sameKeys(parsed, ["message"])) return false;
      const message = parsed.message;
      return (
        isPlainObject(message) &&
        sameKeys(message, ["raw", "threadId"]) &&
        typeof message.raw === "string" &&
        typeof message.threadId === "string"
      );
    } catch {
      return false;
    }
  }
  return method === "GET" && body === undefined && THREAD_READ.test(url);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sameKeys(o: Record<string, unknown>, keys: string[]): boolean {
  const have = Object.keys(o).sort();
  return have.length === keys.length && have.every((k, i) => k === [...keys].sort()[i]);
}

export type DraftsClientDeps = {
  access: GmailComposeAccess;
  fetch: typeof fetch;
  guard: DraftGuard;
};

export type DraftsClient = {
  // Creates the draft in the thread; returns the draft's Gmail message id.
  createDraft: (raw: string, threadId: string, span: Span) => Promise<string>;
  // The message id of a draft in the thread carrying this marker, or null.
  findMarkedDraft: (threadId: string, marker: string, span: Span) => Promise<string | null>;
};

export function createDraftsClient(deps: DraftsClientDeps): DraftsClient {
  // One request through the allowlist, the kill switch and the breaker. Only Gmail's own trouble
  // (no answer, 429, 5xx) counts against the breaker; a 4xx means Gmail answered.
  async function call(url: string, init: RequestInit, span: Span): Promise<Response> {
    if (!requestAllowed(init.method ?? "GET", url, init.body)) {
      throw new DraftRequestError("request outside the draft writer's allowlist");
    }
    let probeToken: string | null;
    try {
      if (!(await deps.guard.isOn(DRAFTS_SUBSYSTEM))) {
        throw new DraftHeldBack("kill_switch", DRAFTS_SUBSYSTEM, null);
      }
      const decision = await deps.guard.acquire(DRAFTS_DEPENDENCY);
      if (!decision.allowed)
        throw new DraftHeldBack("breaker", DRAFTS_DEPENDENCY, decision.retryAt);
      probeToken = decision.probe ? decision.probeToken : null;
    } catch (error) {
      if (error instanceof DraftHeldBack) {
        span.setAttribute("gmail.held_by", error.by);
        throw error;
      }
      // A check that throws holds the request back: no unguarded write.
      span.setAttribute("gmail.held_by", "guard_error");
      throw new DraftHeldBack("guard_error", DRAFTS_DEPENDENCY, null);
    }
    const report = async (outcome: CallOutcome) => {
      try {
        await deps.guard.report(DRAFTS_DEPENDENCY, outcome, probeToken);
      } catch {
        span.setAttribute("gmail.breaker_report_failed", true);
      }
    };
    let res: Response;
    try {
      res = await deps.fetch(url, {
        ...init,
        headers: { authorization: bearerOf(deps.access), "content-type": "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      await report({ ok: false, error: "DraftWriteError" });
      throw new DraftWriteError(`Gmail didn't answer (${(e as Error).name})`, 0);
    }
    span.setAttribute("http.response.status_code", res.status);
    const fault = res.status === 429 || res.status >= 500;
    await report(fault ? { ok: false, error: "DraftWriteError" } : { ok: true });
    if (!res.ok) {
      const reason = await errorReason(res);
      throw new DraftWriteError(
        `Gmail answered ${res.status}${reason ? ` (${reason})` : ""}`,
        res.status,
      );
    }
    return res;
  }

  return {
    async createDraft(raw, threadId, span) {
      if (!/^[0-9a-f]{8,32}$/.test(threadId)) throw new DraftRequestError("threadId");
      const res = await call(
        DRAFTS_URL,
        { method: "POST", body: JSON.stringify({ message: { raw, threadId } }) },
        span,
      );
      const body = (await readJson(res)) as { message?: { id?: unknown } };
      const id = body.message?.id;
      if (typeof id !== "string" || !GMAIL_ID.test(id)) {
        throw new DraftWriteError("Gmail answered without a draft message id", res.status);
      }
      return id;
    },

    async findMarkedDraft(threadId, marker, span) {
      if (!/^[0-9a-f]{8,32}$/.test(threadId)) throw new DraftRequestError("threadId");
      const res = await call(`${THREADS_URL}/${threadId}${THREAD_QUERY}`, { method: "GET" }, span);
      const body = (await readJson(res)) as {
        messages?: {
          id?: unknown;
          labelIds?: unknown;
          payload?: { headers?: { name?: unknown; value?: unknown }[] };
        }[];
      };
      for (const m of body.messages ?? []) {
        const isDraft = Array.isArray(m.labelIds) && m.labelIds.includes("DRAFT");
        const marked = (m.payload?.headers ?? []).some(
          (h) =>
            typeof h.name === "string" &&
            h.name.toLowerCase() === APPROVAL_HEADER.toLowerCase() &&
            h.value === marker,
        );
        if (isDraft && marked && typeof m.id === "string" && GMAIL_ID.test(m.id)) return m.id;
      }
      return null;
    },
  };
}

// Google's reason code from an error body (`rateLimitExceeded`), or "". Only a code of plain
// letters is kept: the message text could quote anything.
async function errorReason(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { errors?: { reason?: unknown }[] } };
    const reason = body.error?.errors?.[0]?.reason;
    return typeof reason === "string" && /^[A-Za-z]{1,40}$/.test(reason) ? reason : "";
  } catch {
    return "";
  }
}

// A success body, or a DraftWriteError: a parse error's message can quote the body.
async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new DraftWriteError("Gmail sent an unreadable answer", res.status);
  }
}
