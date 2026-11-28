import { createHash } from "node:crypto";
import type { EmbeddableJob } from "@northstar/db";
import { HeldBack } from "@northstar/llm";
import { describe, expect, it } from "vitest";
import {
  type EmbedPassDeps,
  type EmbedPassReport,
  embedAfterScore,
  embedPass,
  MAX_JOBS_PER_EMBED_PASS,
} from "./embed-pass.js";
import { embeddingText } from "./embedding-text.js";

// One embedding pass (NS-129 slice 3) on fakes: no database, network or model. Synthetic jobs.

const job = (n: number): EmbeddableJob => ({
  jobId: `job-${n}`,
  title: `Backend Engineer ${n}`,
  company: "Example Corp",
  requirements: ["TypeScript"],
});
const hashOf = (j: EmbeddableJob) =>
  createHash("sha256")
    .update(embeddingText(j) ?? "", "utf8")
    .digest("hex");

function fakes(jobs: EmbeddableJob[], stored = new Map<string, string>()) {
  const sent: string[][] = [];
  const saved: string[] = [];
  const suggestedFor: string[] = [];
  const deps: EmbedPassDeps = {
    jobs: async () => jobs,
    hashes: async (ids) => new Map([...stored].filter(([id]) => ids.includes(id))),
    embed: async (texts) => {
      sent.push([...texts]);
      return texts.map(() => [1, 0]);
    },
    save: async (jobId) => {
      saved.push(jobId);
      return "stored";
    },
    suggest: async (jobId) => {
      suggestedFor.push(jobId);
      return { suggested: 1, existing: 0 };
    },
  };
  return { deps, sent, saved, suggestedFor };
}

describe("embedPass (NS-129 slice 3)", () => {
  it("embeds only jobs whose text changed or that have no vector, in one request", async () => {
    const [a, b, c] = [job(1), job(2), job(3)];
    const f = fakes(
      [a, b, c],
      new Map([
        [a.jobId, hashOf(a)],
        [b.jobId, "0".repeat(64)],
      ]),
    );
    const report = await embedPass(f.deps);
    expect(f.sent).toEqual([[embeddingText(b), embeddingText(c)]]);
    expect([f.saved, report.embedded, report.pending]).toEqual([[b.jobId, c.jobId], 2, 2]);
  });

  it("sends nothing when every job's vector is current", async () => {
    const a = job(1);
    const f = fakes([a], new Map([[a.jobId, hashOf(a)]]));
    expect((await embedPass(f.deps)).pending).toBe(0);
    expect(f.sent).toEqual([]);
  });

  it("skips a job with no title or company, which can't be compared", async () => {
    const f = fakes([{ ...job(1), company: null }]);
    await embedPass(f.deps);
    expect(f.sent).toEqual([]);
  });

  it("takes at most one request's worth, the freshest first", async () => {
    const jobs = Array.from({ length: MAX_JOBS_PER_EMBED_PASS + 3 }, (_, i) => job(i));
    const f = fakes(jobs);
    const report = await embedPass(f.deps);
    expect([f.sent.length, f.sent[0]?.length, report.pending, f.saved[0]]).toEqual([
      1,
      MAX_JOBS_PER_EMBED_PASS,
      MAX_JOBS_PER_EMBED_PASS + 3,
      "job-0",
    ]);
  });

  it("suggests duplicates for each new vector, after the whole batch is stored", async () => {
    const f = fakes([job(1), job(2)]);
    const order: string[] = [];
    const save = f.deps.save;
    f.deps.save = async (...args) => {
      order.push(`save ${args[0]}`);
      return save(...args);
    };
    const suggest = f.deps.suggest;
    f.deps.suggest = async (id) => {
      order.push(`suggest ${id}`);
      return suggest(id);
    };
    const report = await embedPass(f.deps);
    expect(order).toEqual(["save job-1", "save job-2", "suggest job-1", "suggest job-2"]);
    expect(report.suggested).toBe(2);
  });

  it("asks for no suggestion where the save stored nothing", async () => {
    const f = fakes([job(1)]);
    f.deps.save = async () => "unchanged";
    const report = await embedPass(f.deps);
    expect([f.suggestedFor, report.unchanged]).toEqual([[], 1]);
  });

  it("stops with the error's class and stores nothing when the request is held back", async () => {
    const f = fakes([job(1)]);
    f.deps.embed = async () => {
      throw new HeldBack("kill_switch", "agent:job-embed");
    };
    const report = await embedPass(f.deps);
    expect([report.stoppedBy, f.saved]).toEqual(["HeldBack", []]);
  });

  it("keeps going when one job's suggestion step fails", async () => {
    const f = fakes([job(1), job(2)]);
    f.deps.suggest = async (id) => {
      if (id === "job-1") throw new Error("db down");
      return { suggested: 1, existing: 0 };
    };
    const report = await embedPass(f.deps);
    expect([report.suggestFailed, report.suggested]).toEqual([1, 1]);
  });
});

describe("embedAfterScore (NS-129 slice 3)", () => {
  const base: EmbedPassReport = {
    pending: 3,
    embedded: 2,
    unchanged: 0,
    refused: 0,
    suggested: 1,
    suggestFailed: 0,
    stoppedBy: null,
  };
  const lines = async (pass: () => Promise<EmbedPassReport>) => {
    const out: string[] = [];
    await embedAfterScore(pass, (l) => out.push(l));
    return out;
  };

  it("says how many jobs it embedded and how many duplicates it found", async () => {
    expect(await lines(async () => base)).toEqual([
      "Embedded 2 jobs (1 more next pass); 1 possible duplicate (see jobs dupes).",
    ]);
  });

  it("says nothing when there was nothing to embed", async () => {
    expect(await lines(async () => ({ ...base, pending: 0, embedded: 0, suggested: 0 }))).toEqual(
      [],
    );
  });

  it("says the pass didn't run, by the error's class, and never throws", async () => {
    expect(await lines(async () => ({ ...base, embedded: 0, stoppedBy: "HeldBack" }))).toEqual([
      "Job embeddings didn't run (HeldBack); the next pass retries.",
    ]);
    const thrown = await lines(async () => {
      const e = new Error("connection to db.internal refused");
      e.name = "DbDown";
      throw e;
    });
    expect(thrown).toEqual(["Job embeddings didn't run (DbDown); the next pass retries."]);
  });
});
