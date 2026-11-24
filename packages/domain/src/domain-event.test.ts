import { describe, expect, it } from "vitest";
import { applicationEventType, parseDomainEvent } from "./domain-event.js";
import { ApplicationId, CandidateId } from "./ids.js";

// A synthetic, valid event. Every test changes one field of it.
const validEvent = {
  id: "0b6f8f5e-6d1c-4f7e-9a3b-2c1d0e9f8a70",
  candidateId: "11111111-1111-4111-8111-111111111111",
  aggregate: "application:22222222-2222-4222-8222-222222222222",
  type: "application.submitted",
  actor: "agent:apply",
  reason: "Approval 7 granted; form accepted by the ATS",
  inputsSummary: "Package for Example Corp, Backend Engineer",
  payload: { from: "submitting", to: "submitted" },
  links: [{ rel: "job", href: "https://jobs.example.com/backend-engineer" }],
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  idempotencyKey: "application:22222222-2222-4222-8222-222222222222:submit",
  occurredAt: new Date("2026-11-24T12:00:00.000Z"),
};

describe("domain event schema", () => {
  it("accepts an event with every OBS-001 field", () => {
    const result = parseDomainEvent(validEvent);
    expect(result).toEqual({ ok: true, value: validEvent });
  });

  it("accepts an event with no trace and no links", () => {
    const result = parseDomainEvent({ ...validEvent, traceId: null, links: [] });
    expect(result.ok).toBe(true);
  });

  it("rejects an event without an actor", () => {
    const { actor: _actor, ...withoutActor } = validEvent;
    const result = parseDomainEvent(withoutActor);
    expect(result.ok).toBe(false);
  });

  it("rejects an actor that is not an agent, the user or the system", () => {
    const result = parseDomainEvent({ ...validEvent, actor: "someone" });
    expect(result.ok).toBe(false);
  });

  it("rejects an aggregate that is not kind:uuid", () => {
    const result = parseDomainEvent({ ...validEvent, aggregate: "application-22" });
    expect(result.ok).toBe(false);
  });

  it("rejects a trace id that is not 32 lowercase hex characters", () => {
    const result = parseDomainEvent({ ...validEvent, traceId: "not-a-trace" });
    expect(result.ok).toBe(false);
  });

  it("rejects a link that is not http or https", () => {
    // Links come from untrusted job pages and the feed renders them as anchors.
    const result = parseDomainEvent({
      ...validEvent,
      links: [{ rel: "job", href: "javascript:alert(1)" }],
    });
    expect(result).toEqual({
      ok: false,
      error: { kind: "InvalidEvent", fields: ["links.0.href"] },
    });
  });

  it("rejects fields the schema does not know", () => {
    const result = parseDomainEvent({ ...validEvent, emailBody: "hello" });
    expect(result.ok).toBe(false);
  });

  it("names the invalid field in the error", () => {
    const result = parseDomainEvent({ ...validEvent, idempotencyKey: "" });
    expect(result).toEqual({
      ok: false,
      error: { kind: "InvalidEvent", fields: ["idempotencyKey"] },
    });
  });
});

describe("application event type", () => {
  it("names a status change after the status it moves to", () => {
    expect(applicationEventType("package_ready")).toBe("application.package_ready");
  });
});

describe("ids", () => {
  it("accepts a uuid as a candidate id", () => {
    expect(CandidateId.safeParse(validEvent.candidateId).success).toBe(true);
  });

  it("rejects a value that is not a uuid", () => {
    expect(ApplicationId.safeParse("42").success).toBe(false);
  });

  it("does not let one kind of id stand in for another", () => {
    const applicationId = ApplicationId.parse("22222222-2222-4222-8222-222222222222");
    // @ts-expect-error: an ApplicationId is not a CandidateId (typecheck fails if this compiles).
    const wrong: CandidateId = applicationId;
    expect(wrong).toBe(applicationId);
  });
});
