import { createHash } from "node:crypto";
import type { ProfileImportInput } from "@northstar/db";
import { CandidateId } from "@northstar/domain";
import type { CallRecord, LlmGateway, LlmOutcome } from "@northstar/llm";
import { describe, expect, it } from "vitest";
import { importResume } from "./import.js";
import { profileExtractRoute } from "./route.js";
import type { ProfileExtract } from "./schema.js";
import { SAMPLE_RESUME, sampleExtract } from "./test/sample.js";

const candidateId = CandidateId.parse("11111111-1111-4111-8111-111111111111");
const sha = createHash("sha256").update(SAMPLE_RESUME).digest("hex");

const record: CallRecord = {
  route: "profile-extract",
  promptId: "profile-extract",
  promptVersion: 1,
  modelRequested: "claude-opus-5-5",
  modelServed: "claude-opus-5-5",
  effort: "medium",
  inputTokens: 2000,
  outputTokens: 900,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  latencyMs: 4000,
  costUsd: 0.026,
  stopReason: "end_turn",
  refusalCategory: null,
  fallbackUsed: false,
};

// A gateway that answers every call with one outcome and counts the calls.
function gatewayAnswering(outcome: LlmOutcome<ProfileExtract>) {
  const calls: unknown[] = [];
  const gateway: LlmGateway = {
    async call<I, O>(_route: unknown, input: I): Promise<LlmOutcome<O>> {
      calls.push(input);
      return outcome as unknown as LlmOutcome<O>;
    },
  };
  return { gateway, calls };
}

function storeSpy(currentHash: string | null = null) {
  const stored: ProfileImportInput[] = [];
  return {
    stored,
    currentHash: async () => currentHash,
    store: async (input: ProfileImportInput) => {
      stored.push(input);
      return {
        status: "imported" as const,
        sourceId: "22222222-2222-4222-8222-222222222222",
        counts: { roles: 2, education: 1, atoms: 3, skills: 4, certifications: 1, links: 2 },
      };
    },
  };
}

const route = profileExtractRoute();
const run = (gateway: LlmGateway, store: ReturnType<typeof storeSpy>) =>
  importResume(
    { gateway, route, currentHash: store.currentHash, store: store.store },
    { candidateId, fileName: "resume.pdf", text: SAMPLE_RESUME },
  );

describe("importResume", () => {
  it("extracts, validates and stores a faithful resume, with the prompt version and served model", async () => {
    const { gateway, calls } = gatewayAnswering({ kind: "Ok", output: sampleExtract(), record });
    const store = storeSpy();
    const result = await run(gateway, store);
    expect(result).toEqual({
      kind: "imported",
      sourceId: "22222222-2222-4222-8222-222222222222",
      counts: { roles: 2, education: 1, atoms: 3, skills: 4, certifications: 1, links: 2 },
      record,
    });
    expect(calls).toEqual([{ text: SAMPLE_RESUME }]);
    expect(store.stored).toEqual([
      {
        candidateId,
        fileName: "resume.pdf",
        textSha256: sha,
        promptVersion: 1,
        model: "claude-opus-5-5",
        // No tracer provider in this test, so there is no trace to link.
        traceId: null,
        call: record,
        extract: sampleExtract(),
      },
    ]);
  });

  it("skips the model entirely when the resume text hasn't changed", async () => {
    const { gateway, calls } = gatewayAnswering({ kind: "Ok", output: sampleExtract(), record });
    const store = storeSpy(sha);
    expect(await run(gateway, store)).toEqual({ kind: "unchanged" });
    expect(calls).toHaveLength(0);
    expect(store.stored).toHaveLength(0);
  });

  it("with reimport, extracts again even though the text is unchanged, and forces the store", async () => {
    const { gateway, calls } = gatewayAnswering({ kind: "Ok", output: sampleExtract(), record });
    const store = storeSpy(sha);
    const result = await importResume(
      { gateway, route, currentHash: store.currentHash, store: store.store },
      { candidateId, fileName: "resume.pdf", text: SAMPLE_RESUME, reimport: true },
    );
    expect(result.kind).toBe("imported");
    expect(calls).toHaveLength(1);
    expect(store.stored[0]?.force).toBe(true);
  });

  it("writes nothing when the provenance check fails, and names the failures", async () => {
    const bad = sampleExtract();
    const atom = bad.atoms[0];
    if (atom) atom.impact = "cut duplicate charges by 40%";
    const { gateway } = gatewayAnswering({ kind: "Ok", output: bad, record });
    const store = storeSpy();
    expect(await run(gateway, store)).toEqual({
      kind: "rejected",
      failures: [{ item: "atom", index: 0, problem: "number_not_in_quote" }],
      record,
    });
    expect(store.stored).toHaveLength(0);
  });

  it("writes nothing when the model refuses, truncates or returns the wrong shape", async () => {
    for (const outcome of [
      { kind: "Refused", category: null, record },
      { kind: "Truncated", record },
      { kind: "InvalidOutput", reason: "schema", fields: ["roles.0.key"], record },
    ] as LlmOutcome<ProfileExtract>[]) {
      const { gateway } = gatewayAnswering(outcome);
      const store = storeSpy();
      expect(await run(gateway, store)).toEqual({ kind: "model", outcome: outcome.kind, record });
      expect(store.stored).toHaveLength(0);
    }
  });
});

describe("profileExtractRoute", () => {
  it("uses the locked v1 prompt, medium effort, and puts the resume in an untrusted block", () => {
    expect(route.name).toBe("profile-extract");
    expect(route.prompt).toMatchObject({ id: "profile-extract", version: 1 });
    expect(route.effort).toBe("medium");
    const rendered = route.render({ text: "Alex Example" });
    expect(rendered.stable).toEqual([]);
    expect(rendered.volatile).toContain('<untrusted_data kind="resume">');
    expect(rendered.volatile).toContain("Alex Example");
  });
});
