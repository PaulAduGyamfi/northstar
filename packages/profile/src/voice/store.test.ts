import { type Db, reviewVoiceProfile, saveVoiceProfile, schema } from "@northstar/db";
import { createTestDb } from "@northstar/db/testing";
import { CandidateId } from "@northstar/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { avoidedFromDeleted, avoidedPhrases, deletedPhrases } from "./edits.js";
import { measureVoice } from "./measure.js";
import { loadVoice, recordEdit } from "./store.js";

// The stored voice profile and edit history (NS-185) on PGlite. Synthetic writing only.

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const [c] = await db
    .insert(schema.candidate)
    .values({ displayName: "Test Candidate" })
    .returning();
  if (!c) throw new Error("no candidate");
  candidateId = CandidateId.parse(c.id);
});

afterEach(async () => {
  await close();
});

// Five synthetic samples sharing two phrases ("in practice", "ship it").
const SAMPLES = [
  "In practice we ship it early. I like small steps.",
  "I think in practice the plan holds. We ship it on Friday.",
  "Ship it, then measure. In practice that works for me.",
  "I wrote the tests first. In practice it saves time, so ship it.",
  "We agreed to ship it. I checked the numbers in practice.",
];

describe("loadVoice", () => {
  it("gives no guide until Paul has reviewed a measured profile", async () => {
    const measured = measureVoice(SAMPLES);
    if (!measured.ok) throw new Error(measured.problem);
    await saveVoiceProfile(db, { candidateId, measures: measured.profile });
    expect((await loadVoice(db, candidateId)).guide).toBe(null);
  });

  it("feeds the reviewed profile to the guide with only the phrases Paul kept", async () => {
    const measured = measureVoice(SAMPLES);
    if (!measured.ok) throw new Error(measured.problem);
    const phrases = measured.profile.phrases;
    await saveVoiceProfile(db, { candidateId, measures: measured.profile });
    await reviewVoiceProfile(db, {
      candidateId,
      version: 1,
      keep: phrases.filter((p) => p !== "in practice"),
      drop: phrases.filter((p) => p === "in practice"),
    });
    const guide = (await loadVoice(db, candidateId)).guide ?? "";
    expect([
      phrases.includes("in practice"),
      guide.includes('"ship it"'),
      guide.includes('"in practice"'),
    ]).toEqual([true, true, false]);
  });
});

describe("recordEdit and the avoid list", () => {
  it("three stored edits that cut one phrase make it a phrase to avoid", async () => {
    const edits = [
      ["We leverage our data daily.", "We use data daily."],
      ["I leverage our tools well.", "I use tools well."],
      ["They leverage our process.", "They follow the process."],
    ] as const;
    for (const [draft, approved] of edits) await recordEdit(db, candidateId, draft, approved);
    // "our" is a common word, so the learner keeps the habit itself.
    expect((await loadVoice(db, candidateId)).avoid).toEqual(["leverage"]);
  });

  it("two edits aren't enough", async () => {
    await recordEdit(db, candidateId, "We leverage our data.", "We use data.");
    await recordEdit(db, candidateId, "I leverage our tools.", "I use tools.");
    expect((await loadVoice(db, candidateId)).avoid).toEqual([]);
  });

  it("stores only the deleted phrases, never the draft or the approved text", async () => {
    await recordEdit(db, candidateId, "We leverage our data daily.", "We use data daily.");
    const rows = await db.select().from((await import("@northstar/db")).voiceSchema.voiceEdit);
    expect(rows.map((r) => r.deleted)).toEqual([
      deletedPhrases("We leverage our data daily.", "We use data daily."),
    ]);
  });
});

describe("avoidedFromDeleted", () => {
  it("agrees with avoidedPhrases on the same edits", () => {
    const edits = [
      { draft: "We leverage the data.", approved: "We use the data." },
      { draft: "Leverage it now.", approved: "Do it now." },
      { draft: "They leverage our process.", approved: "They follow our process." },
    ];
    expect(avoidedFromDeleted(edits.map((e) => deletedPhrases(e.draft, e.approved)))).toEqual(
      avoidedPhrases(edits),
    );
  });
});
