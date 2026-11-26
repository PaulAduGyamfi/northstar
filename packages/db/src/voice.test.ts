import { CandidateId } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { candidate, domainEvent } from "./schema.js";
import { createTestDb, sqlState } from "./test/pglite.js";
import { voiceEdit, voiceProfile, voiceReview } from "./voice-schema.js";
import {
  readReviewedVoice,
  readVoiceEdits,
  recordVoiceEdit,
  reviewVoiceProfile,
  saveVoiceProfile,
  type VoiceMeasures,
} from "./voice-write.js";

// Paul's voice profile (NS-185, ANS-007/008). Synthetic measurements and phrases only.

const RESTRICT_VIOLATION = "23001";

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;

async function newCandidate(): Promise<CandidateId> {
  const [c] = await db.insert(candidate).values({ displayName: "Test Candidate" }).returning();
  if (!c) throw new Error("no candidate");
  return CandidateId.parse(c.id);
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  candidateId = await newCandidate();
});

afterEach(async () => {
  await close();
});

const MEASURES: VoiceMeasures = {
  samples: 6,
  words: 1800,
  sentenceWords: 14,
  contractionsPer100: 1.2,
  iPer100: 3.4,
  wePer100: 0.8,
  exclamationShare: 0.05,
  phrases: ["ship it", "in practice", "the hard part"],
};

describe("saveVoiceProfile", () => {
  it("numbers each version from 1", async () => {
    const first = await saveVoiceProfile(db, { candidateId, measures: MEASURES });
    const second = await saveVoiceProfile(db, { candidateId, measures: MEASURES });
    expect([first.version, second.version]).toEqual([1, 2]);
  });

  it("writes voice.measured with the version and counts, never a phrase", async () => {
    await saveVoiceProfile(db, { candidateId, measures: MEASURES });
    const events = await db.select().from(domainEvent);
    expect(events.map((e) => [e.type, e.payload])).toEqual([
      ["voice.measured", { version: 1, samples: 6, phrases: 3 }],
    ]);
  });
});

describe("reviewVoiceProfile and readReviewedVoice", () => {
  it("serves nothing until a version is reviewed", async () => {
    await saveVoiceProfile(db, { candidateId, measures: MEASURES });
    expect(await readReviewedVoice(db, candidateId)).toBe(null);
  });

  it("serves the reviewed version with only the phrases Paul kept", async () => {
    await saveVoiceProfile(db, { candidateId, measures: MEASURES });
    await reviewVoiceProfile(db, {
      candidateId,
      version: 1,
      keep: ["ship it", "the hard part"],
      drop: ["in practice"],
    });
    expect(await readReviewedVoice(db, candidateId)).toEqual({
      version: 1,
      measures: { ...MEASURES, phrases: ["ship it", "the hard part"] },
    });
  });

  it("serves the newest reviewed version, and the newest review of it", async () => {
    await saveVoiceProfile(db, { candidateId, measures: MEASURES });
    await saveVoiceProfile(db, { candidateId, measures: { ...MEASURES, samples: 8 } });
    const all = { keep: MEASURES.phrases, drop: [] };
    await reviewVoiceProfile(db, { candidateId, version: 1, ...all });
    await reviewVoiceProfile(db, { candidateId, version: 2, ...all });
    await reviewVoiceProfile(db, {
      candidateId,
      version: 2,
      keep: ["ship it"],
      drop: ["in practice", "the hard part"],
    });
    const voice = await readReviewedVoice(db, candidateId);
    expect([voice?.version, voice?.measures.samples, voice?.measures.phrases]).toEqual([
      2,
      8,
      ["ship it"],
    ]);
  });

  it("refuses a review that leaves a phrase undecided or names one the version lacks", async () => {
    await saveVoiceProfile(db, { candidateId, measures: MEASURES });
    const results = [
      await reviewVoiceProfile(db, { candidateId, version: 1, keep: ["ship it"], drop: [] }),
      await reviewVoiceProfile(db, {
        candidateId,
        version: 1,
        keep: [...MEASURES.phrases, "synergy"],
        drop: [],
      }),
      await reviewVoiceProfile(db, {
        candidateId,
        version: 1,
        keep: MEASURES.phrases,
        drop: ["ship it"],
      }),
    ];
    expect(results.map((r) => (r.ok ? "ok" : r.error.kind))).toEqual([
      "PhrasesMismatch",
      "PhrasesMismatch",
      "PhrasesMismatch",
    ]);
  });

  it("refuses a review of a version that doesn't exist, or is another candidate's", async () => {
    await saveVoiceProfile(db, { candidateId, measures: MEASURES });
    const review = { keep: MEASURES.phrases, drop: [] };
    const results = [
      await reviewVoiceProfile(db, { candidateId, version: 2, ...review }),
      await reviewVoiceProfile(db, { candidateId: await newCandidate(), version: 1, ...review }),
    ];
    expect(results.map((r) => (r.ok ? "ok" : r.error.kind))).toEqual(["NotFound", "NotFound"]);
  });

  it("writes voice.reviewed with counts only", async () => {
    await saveVoiceProfile(db, { candidateId, measures: MEASURES });
    await reviewVoiceProfile(db, {
      candidateId,
      version: 1,
      keep: ["ship it"],
      drop: ["in practice", "the hard part"],
    });
    const events = await db.select().from(domainEvent);
    expect(events.map((e) => [e.type, e.payload])[1]).toEqual([
      "voice.reviewed",
      { version: 1, kept: 1, dropped: 2 },
    ]);
  });
});

describe("recordVoiceEdit and readVoiceEdits", () => {
  it("stores each edit's deleted phrases and reads them back oldest first", async () => {
    await recordVoiceEdit(db, { candidateId, deleted: ["leverage our"] });
    await recordVoiceEdit(db, { candidateId, deleted: ["very", "leverage our"] });
    expect(await readVoiceEdits(db, candidateId)).toEqual([
      ["leverage our"],
      ["very", "leverage our"],
    ]);
  });

  it("stores nothing for an edit that deleted nothing", async () => {
    await recordVoiceEdit(db, { candidateId, deleted: [] });
    expect(await db.select().from(voiceEdit)).toEqual([]);
  });

  it("reads only the given candidate's edits", async () => {
    await recordVoiceEdit(db, { candidateId, deleted: ["very"] });
    expect(await readVoiceEdits(db, await newCandidate())).toEqual([]);
  });
});

describe("database guards", () => {
  it("refuses changing or deleting any voice row", async () => {
    await saveVoiceProfile(db, { candidateId, measures: MEASURES });
    await reviewVoiceProfile(db, { candidateId, version: 1, keep: MEASURES.phrases, drop: [] });
    await recordVoiceEdit(db, { candidateId, deleted: ["very"] });
    expect([
      await sqlState(db.update(voiceProfile).set({ samples: 9 })),
      await sqlState(db.delete(voiceReview)),
      await sqlState(db.delete(voiceEdit)),
    ]).toEqual([RESTRICT_VIOLATION, RESTRICT_VIOLATION, RESTRICT_VIOLATION]);
  });
});
