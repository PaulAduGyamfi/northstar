import { replyContentSha256, replySubject } from "@northstar/domain";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { DraftWriteError } from "./errors.js";
import { writeReplyDraft } from "./gateway.js";
import {
  CANDIDATE,
  composeAccess,
  created,
  DECISION,
  fakeGmail,
  fakeLedger,
  fakePorts,
  json,
  LEASE_END,
  PACKAGE,
  REQUEST,
  storedDraft,
  THREAD,
} from "./test/fixtures.js";

const input = { candidateId: CANDIDATE, decisionId: DECISION, requestId: REQUEST };

// The headers and body of the message Gmail was given, decoded from `raw`.
function sentMessage(body: string | undefined): string {
  const raw = (JSON.parse(body ?? "{}") as { message: { raw: string } }).message.raw;
  return Buffer.from(raw, "base64url").toString("utf8");
}

describe("writeReplyDraft (NS-237 slice 4, ADR-0025)", () => {
  it.each([
    "NotFound",
    "Rejected",
    "Undone",
    "SubjectMismatch",
    "ContentChanged",
    "Withdrawn",
  ] as const)("sends nothing to Gmail when the Gate answers %s", async (refusal) => {
    const gmail = fakeGmail(() => created());
    const { ports, ledger } = fakePorts({ fetch: gmail.fetch, refusal: { kind: refusal } });
    const result = await writeReplyDraft(ports, composeAccess(), input);
    expect(result).toEqual({ ok: false, error: { kind: "NotApproved", reason: refusal } });
    expect(gmail.calls).toEqual([]);
    expect(ledger.rows.size).toBe(0);
  });

  it("asks the Gate for this exact reply: kind email_reply, the message's subject and its hash", async () => {
    const gmail = fakeGmail(() => created());
    const { ports, verified } = fakePorts({ fetch: gmail.fetch });
    await writeReplyDraft(ports, composeAccess(), input);
    expect(verified).toEqual([
      {
        candidateId: CANDIDATE,
        decisionId: DECISION,
        kind: "email_reply",
        subject: replySubject(PACKAGE.gmailMessageId),
        contentSha256: replyContentSha256(PACKAGE),
      },
    ]);
  });

  it("refuses a request with no stored draft", async () => {
    const gmail = fakeGmail(() => created());
    const { ports, verified } = fakePorts({ fetch: gmail.fetch, draft: null });
    expect(await writeReplyDraft(ports, composeAccess(), input)).toEqual({
      ok: false,
      error: { kind: "NotFound" },
    });
    expect(verified).toEqual([]);
    expect(gmail.calls).toEqual([]);
  });

  it("refuses a stored draft whose content no longer matches its stored hash, before the Gate", async () => {
    const gmail = fakeGmail(() => created());
    const tampered = storedDraft(
      { ...PACKAGE, body: "Something else." },
      replyContentSha256(PACKAGE),
    );
    const { ports, verified } = fakePorts({ fetch: gmail.fetch, draft: tampered });
    expect(await writeReplyDraft(ports, composeAccess(), input)).toEqual({
      ok: false,
      error: { kind: "ContentMismatch" },
    });
    expect(verified).toEqual([]);
    expect(gmail.calls).toEqual([]);
  });

  it("returns needs_human (scope_missing) and calls nothing when the grant lacks gmail.compose", async () => {
    const gmail = fakeGmail(() => created());
    const { ports, ledger } = fakePorts({ fetch: gmail.fetch });
    const readonly = composeAccess(["https://www.googleapis.com/auth/gmail.readonly"]);
    expect(await writeReplyDraft(ports, readonly, input)).toEqual({
      ok: true,
      value: { kind: "needs_human", reason: "scope_missing" },
    });
    expect(gmail.calls).toEqual([]);
    expect(ledger.rows.size).toBe(0);
  });

  it("creates one draft in the thread with exactly the approved headers, body and the marker", async () => {
    const gmail = fakeGmail(() => created("18c2f0a1b2c3d4ff"));
    const { ports, ledger } = fakePorts({ fetch: gmail.fetch });
    const result = await writeReplyDraft(ports, composeAccess(), input);
    expect(result).toEqual({
      ok: true,
      value: { kind: "created", draftMessageId: "18c2f0a1b2c3d4ff" },
    });
    expect(gmail.calls.map((c) => [c.method, c.url])).toEqual([
      ["POST", "https://gmail.googleapis.com/gmail/v1/users/me/drafts"],
    ]);
    const sent = JSON.parse(gmail.calls[0]?.body ?? "{}") as { message: { threadId: string } };
    expect(sent.message.threadId).toBe(THREAD);
    const message = sentMessage(gmail.calls[0]?.body);
    const [head, body] = message.split("\r\n\r\n");
    expect(head?.split("\r\n")).toEqual([
      "To: recruiter@example.com",
      "Subject: Re: Platform engineer role",
      "In-Reply-To: <abc123@example.com>",
      "References: <abc123@example.com>",
      `X-Northstar-Approval: ${DECISION}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
    ]);
    expect(Buffer.from(body ?? "", "base64").toString("utf8")).toBe(PACKAGE.body);
    expect(ledger.rows.get(DECISION)).toBe("18c2f0a1b2c3d4ff");
  });

  it("makes one draft when it runs twice for one approval", async () => {
    const gmail = fakeGmail(() => created());
    const ledger = fakeLedger();
    const { ports } = fakePorts({ fetch: gmail.fetch, ledger });
    await writeReplyDraft(ports, composeAccess(), input);
    const again = await writeReplyDraft(ports, composeAccess(), input);
    expect(again).toEqual({
      ok: true,
      value: { kind: "already_created", draftMessageId: "18c2f0a1b2c3d4ff" },
    });
    expect(gmail.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("after an unknown outcome, finds the marked draft in the thread and creates no second one", async () => {
    const ledger = fakeLedger();
    ledger.rows.set(DECISION, null);
    const gmail = fakeGmail(() =>
      json(200, {
        messages: [
          { id: "18c2f0a1b2c3d4e6", labelIds: ["INBOX"], payload: { headers: [] } },
          {
            id: "18c2f0a1b2c3d500",
            labelIds: ["DRAFT"],
            payload: { headers: [{ name: "X-Northstar-Approval", value: "another-decision" }] },
          },
          {
            id: "18c2f0a1b2c3d4ff",
            labelIds: ["DRAFT"],
            payload: { headers: [{ name: "x-northstar-approval", value: DECISION }] },
          },
        ],
      }),
    );
    const { ports } = fakePorts({ fetch: gmail.fetch, ledger });
    const result = await writeReplyDraft(ports, composeAccess(), input);
    expect(result).toEqual({
      ok: true,
      value: { kind: "already_created", draftMessageId: "18c2f0a1b2c3d4ff" },
    });
    expect(gmail.calls.map((c) => c.method)).toEqual(["GET"]);
    expect(gmail.calls[0]?.url).toBe(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${THREAD}?format=metadata&metadataHeaders=X-Northstar-Approval`,
    );
    expect(ledger.rows.get(DECISION)).toBe("18c2f0a1b2c3d4ff");
  });

  it("after an unknown outcome with no marked draft in the thread, creates the draft", async () => {
    const ledger = fakeLedger();
    ledger.rows.set(DECISION, null);
    const gmail = fakeGmail((c) => (c.method === "GET" ? json(200, { messages: [] }) : created()));
    const { ports } = fakePorts({ fetch: gmail.fetch, ledger });
    const result = await writeReplyDraft(ports, composeAccess(), input);
    expect(result).toEqual({
      ok: true,
      value: { kind: "created", draftMessageId: "18c2f0a1b2c3d4ff" },
    });
    expect(gmail.calls.map((c) => c.method)).toEqual(["GET", "POST"]);
  });

  it("holds the draft back with no request while the gmail_drafts switch is off", async () => {
    const gmail = fakeGmail(() => created());
    const { ports } = fakePorts({ fetch: gmail.fetch, switchOn: false });
    expect(await writeReplyDraft(ports, composeAccess(), input)).toEqual({
      ok: false,
      error: { kind: "HeldBack", by: "kill_switch", what: "gmail_drafts", retryAt: null },
    });
    expect(gmail.calls).toEqual([]);
  });

  it("holds the draft back with no request while the gmail breaker is open", async () => {
    const gmail = fakeGmail(() => created());
    const { ports } = fakePorts({ fetch: gmail.fetch, breakerOpen: true });
    const result = await writeReplyDraft(ports, composeAccess(), input);
    expect(result).toEqual({
      ok: false,
      error: { kind: "HeldBack", by: "breaker", what: "gmail", retryAt: new Date(60_000) },
    });
    expect(gmail.calls).toEqual([]);
  });

  it("counts a 503 against the breaker and leaves the claim unknown for the retry", async () => {
    const gmail = fakeGmail(() => json(503, { error: { errors: [{ reason: "backendError" }] } }));
    const { ports, reports, ledger } = fakePorts({ fetch: gmail.fetch });
    await expect(writeReplyDraft(ports, composeAccess(), input)).rejects.toThrow(
      new DraftWriteError("Gmail answered 503 (backendError)", 503),
    );
    expect(reports).toEqual([{ ok: false, error: "DraftWriteError" }]);
    expect(ledger.rows.get(DECISION)).toBeNull();
  });

  it("doesn't count a 400 against the breaker: Gmail answered", async () => {
    const gmail = fakeGmail(() =>
      json(400, { error: { errors: [{ reason: "invalidArgument" }] } }),
    );
    const { ports, reports } = fakePorts({ fetch: gmail.fetch });
    await expect(writeReplyDraft(ports, composeAccess(), input)).rejects.toThrow(
      new DraftWriteError("Gmail answered 400 (invalidArgument)", 400),
    );
    expect(reports).toEqual([{ ok: true }]);
  });

  it("counts no answer from Gmail against the breaker", async () => {
    const fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    const { ports, reports } = fakePorts({ fetch });
    await expect(writeReplyDraft(ports, composeAccess(), input)).rejects.toThrow(
      "Gmail didn't answer (TypeError)",
    );
    expect(reports).toEqual([{ ok: false, error: "DraftWriteError" }]);
  });

  it("refuses during the undo window with the window's end as the time to come back", async () => {
    const gmail = fakeGmail(() => created());
    const effectiveAt = new Date("2026-11-27T01:02:00Z");
    const { ports } = fakePorts({
      fetch: gmail.fetch,
      refusal: { kind: "UndoWindowOpen", effectiveAt },
    });
    expect(await writeReplyDraft(ports, composeAccess(), input)).toEqual({
      ok: false,
      error: { kind: "NotApproved", reason: "UndoWindowOpen", retryAt: effectiveAt },
    });
    expect(gmail.calls).toEqual([]);
  });

  it("refuses when the Gate's decision approved another request than the one asked for", async () => {
    const gmail = fakeGmail(() => created());
    const { ports, ledger } = fakePorts({
      fetch: gmail.fetch,
      approvedRequest: "33333333-3333-4333-8333-333333333333",
    });
    expect(await writeReplyDraft(ports, composeAccess(), input)).toEqual({
      ok: false,
      error: { kind: "NotApproved", reason: "RequestMismatch" },
    });
    expect(gmail.calls).toEqual([]);
    expect(ledger.rows.size).toBe(0);
  });

  it("refuses a stored draft that no longer passes the reply schema, before the Gate", async () => {
    const gmail = fakeGmail(() => created());
    const bad = { ...storedDraft(), body: "Hi\u202e there" };
    const { ports, verified } = fakePorts({ fetch: gmail.fetch, draft: bad });
    expect(await writeReplyDraft(ports, composeAccess(), input)).toEqual({
      ok: false,
      error: { kind: "ContentMismatch" },
    });
    expect(verified).toEqual([]);
  });

  it("creates nothing while another run holds the approval's claim, and says when to come back", async () => {
    const ledger = fakeLedger();
    ledger.rows.set(DECISION, null);
    ledger.live.add(DECISION);
    const gmail = fakeGmail(() => created());
    const { ports } = fakePorts({ fetch: gmail.fetch, ledger });
    expect(await writeReplyDraft(ports, composeAccess(), input)).toEqual({
      ok: false,
      error: { kind: "InProgress", retryAt: LEASE_END },
    });
    expect(gmail.calls).toEqual([]);
  });

  it("counts a 429 against the breaker", async () => {
    const gmail = fakeGmail(() =>
      json(429, { error: { errors: [{ reason: "rateLimitExceeded" }] } }),
    );
    const { ports, reports } = fakePorts({ fetch: gmail.fetch });
    await expect(writeReplyDraft(ports, composeAccess(), input)).rejects.toThrow(
      new DraftWriteError("Gmail answered 429 (rateLimitExceeded)", 429),
    );
    expect(reports).toEqual([{ ok: false, error: "DraftWriteError" }]);
  });

  it("holds the draft back with no request when the guard itself fails", async () => {
    const gmail = fakeGmail(() => created());
    const { ports } = fakePorts({ fetch: gmail.fetch, guardThrows: true });
    expect(await writeReplyDraft(ports, composeAccess(), input)).toEqual({
      ok: false,
      error: { kind: "HeldBack", by: "guard_error", what: "gmail", retryAt: null },
    });
    expect(gmail.calls).toEqual([]);
  });

  it("puts only the outcome and the HTTP status on its span, never an address, subject, id or token", async () => {
    const exporter = new InMemorySpanExporter();
    trace.setGlobalTracerProvider(
      new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
    );
    try {
      const gmail = fakeGmail(() => created());
      const { ports } = fakePorts({ fetch: gmail.fetch });
      await writeReplyDraft(ports, composeAccess(), input);
      const spans = exporter.getFinishedSpans().filter((s) => s.name === "gmail.write_reply_draft");
      expect(spans.map((s) => s.attributes)).toEqual([
        { "http.response.status_code": 200, "northstar.mail.outcome": "created" },
      ]);
    } finally {
      trace.disable();
    }
  });
});
