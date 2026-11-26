import { type CallRecord, HeldBack, type LlmGateway, type LlmOutcome } from "@northstar/llm";
import { describe, expect, it } from "vitest";
import type { FullMessage } from "./gmail.js";
import { type MailClassifyInput, mailClassifyRoute } from "./mail-classify-route.js";
import type { MailClassification } from "./mail-schema.js";
import { classifyLinkedMail } from "./triage.js";

// Synthetic companies and mail only (the repo is public). A scripted gateway: no model, no network.
const RECORD: CallRecord = {
  route: "mail-classify",
  promptId: "mail-classify",
  promptVersion: 1,
  modelRequested: "claude-opus-5-5",
  modelServed: "claude-opus-5-5",
  effort: "low",
  inputTokens: 900,
  outputTokens: 60,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  latencyMs: 1200,
  costUsd: 0.01,
  stopReason: "end_turn",
  refusalCategory: null,
  fallbackUsed: false,
};
const STAMP = { promptVersion: 1, model: "claude-opus-5-5" };

function gateway(answer: () => LlmOutcome<MailClassification> | Error) {
  const calls: MailClassifyInput[] = [];
  const gw: LlmGateway = {
    call: (async (_route: unknown, input: unknown) => {
      calls.push(input as MailClassifyInput);
      const out = answer();
      if (out instanceof Error) throw out;
      return out;
    }) as LlmGateway["call"],
  };
  return { deps: { gateway: gw, route: mailClassifyRoute() }, calls };
}

const ok = (output: MailClassification): LlmOutcome<MailClassification> => ({
  kind: "Ok",
  output,
  record: RECORD,
});

function mail(over: Partial<FullMessage> = {}): FullMessage {
  return {
    id: "m-1",
    threadId: "t-1",
    from: "Globex Recruiting <jobs@example.com>",
    senderDomain: "globex.example.com",
    subject: "An update on your application",
    deliveredTo: "candidate@example.com",
    authenticationResults: "mx.google.com; dmarc=pass header.from=globex.example.com",
    receivedAt: new Date("2026-11-20T10:00:00Z"),
    body: "Thank you for your interest in the Platform Engineer role at Globex. We have decided not to move forward.",
    ...over,
  };
}

const REJECTION: MailClassification = {
  kind: "rejection",
  company: "Globex",
  role: "Platform Engineer",
  requisition: null,
  stageSignal: "none",
};

describe("classifyLinkedMail", () => {
  it("classifies a rejection through the route and stamps the prompt and model", async () => {
    const { deps, calls } = gateway(() => ok(REJECTION));
    expect(await classifyLinkedMail(deps, mail())).toEqual({
      kind: "classified",
      by: "model",
      classification: REJECTION,
      stamp: STAMP,
    });
    expect(calls).toEqual([
      {
        from: "Globex Recruiting <jobs@example.com>",
        subject: "An update on your application",
        date: "2026-11-20",
        body: mail().body,
      },
    ]);
  });

  it("classifies a standard confirmation subject from a verified sender by rules, with no model call", async () => {
    const { deps, calls } = gateway(() => new Error("no call expected"));
    const result = await classifyLinkedMail(
      deps,
      mail({ subject: "Thank you for applying for the Platform Engineer role at Globex" }),
    );
    expect(result).toEqual({
      kind: "classified",
      by: "rules",
      classification: {
        kind: "confirmation",
        company: "Globex",
        role: "Platform Engineer",
        requisition: null,
        stageSignal: "none",
      },
    });
    expect(calls).toEqual([]);
  });

  it("sends a confirmation subject from an unverified sender to the model", async () => {
    const { deps, calls } = gateway(() => ok({ ...REJECTION, kind: "confirmation" }));
    await classifyLinkedMail(
      deps,
      mail({
        subject: "Thank you for applying for the Platform Engineer role at Globex",
        authenticationResults: null,
      }),
    );
    expect(calls).toHaveLength(1);
  });

  it("never sends verification mail to the model, by subject or by a code in the body", async () => {
    const { deps, calls } = gateway(() => ok(REJECTION));
    const bySubject = mail({ senderDomain: "myworkday.com", subject: "Verify your email" });
    const byBody = mail({
      senderDomain: "myworkday.com",
      subject: "Welcome",
      body: "Your verification code is 482913.",
    });
    expect(await classifyLinkedMail(deps, bySubject)).toEqual({
      kind: "skip",
      reason: "verification",
    });
    expect(await classifyLinkedMail(deps, byBody)).toEqual({
      kind: "skip",
      reason: "verification",
    });
    expect(calls).toEqual([]);
  });

  it("sends a reply naming a company not in the email to review", async () => {
    const { deps } = gateway(() => ok({ ...REJECTION, company: "Initech" }));
    expect(await classifyLinkedMail(deps, mail())).toEqual({
      kind: "review",
      reason: "provenance",
      stamp: STAMP,
    });
  });

  it("checks names only against the part of the body the model saw", async () => {
    // The employer appears only after the cut at BODY_LIMIT (6,000 characters).
    const body = `${"x ".repeat(3_100)}Globex`;
    const { deps } = gateway(() => ok(REJECTION));
    expect(await classifyLinkedMail(deps, mail({ body, subject: "Update" }))).toEqual({
      kind: "review",
      reason: "provenance",
      stamp: STAMP,
    });
  });

  it("sends a reply with no employer to review, unless it's info_other", async () => {
    const none = gateway(() => ok({ ...REJECTION, company: null, role: null }));
    expect(await classifyLinkedMail(none.deps, mail())).toEqual({
      kind: "review",
      reason: "ambiguous",
      stamp: STAMP,
    });
    const other: MailClassification = {
      ...REJECTION,
      kind: "info_other",
      company: null,
      role: null,
    };
    const info = gateway(() => ok(other));
    expect(await classifyLinkedMail(info.deps, mail())).toEqual({
      kind: "classified",
      by: "model",
      classification: other,
      stamp: STAMP,
    });
  });

  it("sends a refusal, a truncated reply and invalid output to review", async () => {
    const outcomes: [LlmOutcome<MailClassification>, string][] = [
      [{ kind: "Refused", category: null, record: RECORD }, "refused"],
      [{ kind: "Truncated", record: RECORD }, "truncated"],
      [
        { kind: "InvalidOutput", reason: "schema", fields: ["kind"], record: RECORD },
        "invalid_output",
      ],
    ];
    for (const [outcome, reason] of outcomes) {
      const { deps } = gateway(() => outcome);
      expect(await classifyLinkedMail(deps, mail())).toEqual({
        kind: "review",
        reason,
        stamp: STAMP,
      });
    }
  });

  it("throws a held-back call to the caller instead of deciding the message", async () => {
    const held = new HeldBack("kill_switch", "agent:mail-classify", null);
    const { deps } = gateway(() => held);
    await expect(classifyLinkedMail(deps, mail())).rejects.toBe(held);
  });
});
