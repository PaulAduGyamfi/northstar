import { admit, type CallGuard, type GuardOutcome } from "@northstar/llm";
import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import type { GmailLabelAccess } from "./access.js";
import { LABEL_NAMES } from "./names.js";

// The Gmail label writer (NS-229, ADR-0027, Proposed). It only ever adds Northstar's own labels to
// a thread: list labels, create a missing `Northstar/…` label, and `threads.modify` with
// `addLabelIds`. Never remove, send, trash, delete, draft or filter (a boundary test checks the
// files here). Its token has `gmail.modify`, so it is kept apart from the code that reads mail.
// No caller yet: nothing requests the scope until Paul accepts ADR-0027.

// Every URL is built from these constants and an id checked against GMAIL_ID.
const LABELS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/labels";
const THREADS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/threads";
// Gmail's message, thread and label ids: letters, digits and `_` (label ids look like Label_12).
const GMAIL_ID = /^[A-Za-z0-9_]{1,64}$/;
// Our names by their lower-case form, to find a label Gmail already has under another case.
const BY_LOWER = new Map([...LABEL_NAMES].map((n) => [n.toLowerCase(), n]));
// The dots in the host are escaped, so only Gmail's own host matches.
const MODIFY_URL = new RegExp(`^${THREADS_URL.replaceAll(".", "\\.")}/[A-Za-z0-9_]{1,64}/modify$`);

// Whether a request is one the writer may send (ADR-0027): list or create labels, or add labels to
// one thread with a body whose only key is addLabelIds. Checked on every request, below the text
// scan in boundary.test.ts.
export function requestAllowed(method: string, url: string, body: unknown): boolean {
  if (url === LABELS_URL) return method === "GET" || method === "POST";
  if (method !== "POST" || !MODIFY_URL.test(url) || typeof body !== "string") return false;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const keys = Object.keys(parsed);
    return keys.length === 1 && keys[0] === "addLabelIds";
  } catch {
    return false;
  }
}

// The breaker every Gmail call goes through, and this writer's own kill switch (ADR-0007).
export const LABELS_DEPENDENCY = "gmail";
export const LABELS_SUBSYSTEM = "gmail_labels";
const TIMEOUT_MS = 30_000;

export type LabelWriterDeps = {
  // Its own token type: never the mail reader's GmailAccess (ADR-0027).
  access: GmailLabelAccess;
  fetch: typeof fetch;
  // Required: labels never go out unguarded.
  guard: CallGuard;
};

// An answer from Gmail that isn't a success. The message names the status and Google's reason
// code only, never its text, a token or an id.
export class LabelWriteError extends Error {
  override name = "LabelWriteError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// Input the writer refuses before any request: a bug in the caller, never retried.
export class LabelInputError extends Error {
  override name = "LabelInputError";
}

export type LabelWriter = {
  // Adds the given Northstar labels to the thread. Safe to repeat.
  labelThread: (threadId: string, names: readonly string[]) => Promise<{ created: number }>;
};

export function createLabelWriter(deps: LabelWriterDeps): LabelWriter {
  const tracer = trace.getTracer("@northstar/inbox");
  // Label name → id, read once per writer (one run). Filled again after a create conflict.
  let known: Map<string, string> | null = null;

  // One request through the allowlist, the kill switch and the breaker. Only Gmail's own trouble (no answer,
  // 429, 5xx) counts against the breaker; a 4xx means Gmail answered.
  async function call(url: string, init: RequestInit, span: Span): Promise<Response> {
    // The runtime allowlist: whatever the code around it becomes, only these requests go out.
    if (!requestAllowed(init.method ?? "GET", url, init.body)) {
      throw new LabelInputError("request outside the label writer's allowlist");
    }
    const admission = await admit(deps.guard, {
      subsystem: LABELS_SUBSYSTEM,
      dependency: LABELS_DEPENDENCY,
    });
    if (!admission.ok) {
      span.setAttribute("gmail.held_by", admission.held.by);
      throw admission.held;
    }
    const report = async (outcome: GuardOutcome) => {
      try {
        await deps.guard.report(LABELS_DEPENDENCY, outcome, admission.probeToken);
      } catch {
        span.setAttribute("gmail.breaker_report_failed", true);
      }
    };
    let res: Response;
    try {
      res = await deps.fetch(url, {
        ...init,
        headers: { authorization: deps.access.authorization(), "content-type": "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      await report({ ok: false, error: "LabelWriteError" });
      throw new LabelWriteError(`Gmail didn't answer (${(e as Error).name})`, 0);
    }
    span.setAttribute("http.response.status_code", res.status);
    const fault = res.status === 429 || res.status >= 500;
    await report(fault ? { ok: false, error: "LabelWriteError" } : { ok: true });
    return res;
  }

  async function fail(res: Response, what: string): Promise<never> {
    const reason = await errorReason(res);
    throw new LabelWriteError(
      `${what}: Gmail answered ${res.status}${reason ? ` (${reason})` : ""}`,
      res.status,
    );
  }

  async function listLabels(span: Span): Promise<Map<string, string>> {
    const res = await call(LABELS_URL, { method: "GET" }, span);
    if (!res.ok) await fail(res, "list labels");
    const body = (await readJson(res, "list labels")) as {
      labels?: { id?: unknown; name?: unknown }[];
    };
    const map = new Map<string, string>();
    for (const l of body.labels ?? []) {
      // Only our own names matter, and only ids of Gmail's shape are ever put in a URL or body.
      // Gmail compares label names without case, so "northstar/offer" is our Northstar/Offer.
      const ours = typeof l.name === "string" ? BY_LOWER.get(l.name.toLowerCase()) : undefined;
      if (ours && typeof l.id === "string" && GMAIL_ID.test(l.id)) map.set(ours, l.id);
    }
    return map;
  }

  // The label's id, creating the label when it doesn't exist. Returns whether it was created.
  async function ensure(name: string, span: Span): Promise<{ id: string; created: boolean }> {
    known ??= await listLabels(span);
    const have = known.get(name);
    if (have) return { id: have, created: false };
    const res = await call(
      LABELS_URL,
      {
        method: "POST",
        body: JSON.stringify({
          name,
          labelListVisibility: "labelShow",
          messageListVisibility: "show",
        }),
      },
      span,
    );
    // 409: another run created it meanwhile. List again rather than create twice.
    if (res.status === 409) {
      known = await listLabels(span);
      const id = known.get(name);
      if (!id)
        throw new LabelWriteError("create label: Gmail answered 409 but the label is missing", 409);
      return { id, created: false };
    }
    if (!res.ok) await fail(res, "create label");
    const body = (await readJson(res, "create label")) as { id?: unknown };
    if (typeof body.id !== "string" || !GMAIL_ID.test(body.id)) {
      throw new LabelWriteError("create label: Gmail answered without a label id", res.status);
    }
    known.set(name, body.id);
    return { id: body.id, created: true };
  }

  return {
    labelThread(threadId, names) {
      return tracer.startActiveSpan("gmail.label_thread", async (span) => {
        try {
          // Checked before any request: a wrong id or name is the caller's bug.
          if (!GMAIL_ID.test(threadId)) throw new LabelInputError("threadId is not a Gmail id");
          const wanted = [...new Set(names)];
          if (wanted.some((n) => !LABEL_NAMES.has(n))) {
            throw new LabelInputError("not a Northstar label name");
          }
          span.setAttribute("gmail.labels", wanted.length);
          if (wanted.length === 0) return { created: 0 };
          let created = 0;
          const ids: string[] = [];
          for (const name of wanted) {
            const label = await ensure(name, span);
            if (label.created) created++;
            ids.push(label.id);
          }
          // addLabelIds only: adding a label the thread already has changes nothing.
          const res = await call(
            `${THREADS_URL}/${threadId}/modify`,
            { method: "POST", body: JSON.stringify({ addLabelIds: ids }) },
            span,
          );
          if (!res.ok) await fail(res, "label thread");
          span.setAttribute("gmail.labels_created", created);
          return { created };
        } catch (error) {
          // The error's name only: never a message that could hold an id.
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.name : "Error",
          });
          throw error;
        } finally {
          span.end();
        }
      });
    },
  };
}

// Google's reason code from an error body (`rateLimitExceeded`, `notFound`), or "" when there is
// none. Only a code of plain letters is kept: the message text could quote anything.
async function errorReason(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { errors?: { reason?: unknown }[] } };
    const reason = body.error?.errors?.[0]?.reason;
    return typeof reason === "string" && /^[A-Za-z]{1,40}$/.test(reason) ? reason : "";
  } catch {
    return "";
  }
}

// A success body, or a LabelWriteError: a parse error's message can quote the body (for a list,
// Paul's own label names), so it never reaches the caller.
async function readJson(res: Response, what: string): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new LabelWriteError(`${what}: Gmail sent an unreadable answer`, res.status);
  }
}
