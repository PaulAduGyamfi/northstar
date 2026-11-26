import { describe, expect, it } from "vitest";
import { VOICE_USAGE, type VoiceCliDeps, voiceCommand } from "./voice-cli.js";

// `profile voice` and `profile voice review` (NS-222) with every dependency faked. Invented
// writing samples only.

// Five short samples that share the phrase "in practice" three times or more.
const SAMPLES: Record<string, string> = {
  "a.txt": "In practice we shipped it. It worked.",
  "b.txt": "In practice I'd test first. Then ship.",
  "c.txt": "We tried it in practice and it held!",
  "d.txt": "The plan was simple. We kept it small.",
  "e.txt": "I wrote the notes. They helped the team.",
};
const FILES = Object.keys(SAMPLES).map((f) => `data/${f}`);

type Newest = { version: number; phrases: string[]; reviewed: boolean } | null;

function deps(over: Partial<VoiceCliDeps> = {}, newest: Newest = null) {
  const printed: string[] = [];
  const saved: unknown[] = [];
  const reviews: { version: number; keep: string[]; drop: string[] }[] = [];
  const d: VoiceCliDeps = {
    print: (line) => printed.push(line),
    readSample: async (path) => {
      const text = SAMPLES[path.replace("data/", "")];
      if (text === undefined) throw new Error(`${path.replace("data/", "")}: not found`);
      return text;
    },
    saveVoiceProfile: async (measures) => {
      saved.push(measures);
      return { version: 3 };
    },
    readNewestVoice: async () => newest,
    reviewVoiceProfile: async (input) => {
      const phrases = newest?.phrases ?? [];
      const decided = [...input.keep, ...input.drop];
      const exact =
        decided.length === phrases.length &&
        new Set(decided).size === decided.length &&
        decided.every((p) => phrases.includes(p));
      if (!exact) return { ok: false, error: { kind: "PhrasesMismatch" } };
      reviews.push(input);
      return { ok: true, value: undefined };
    },
    ...over,
  };
  return { d, printed, saved, reviews };
}

describe("profile voice (measure)", () => {
  it("prints the guide and phrases and stores nothing without --save", async () => {
    const { d, printed, saved } = deps();
    const code = await voiceCommand(d, FILES);
    expect([code, saved.length, printed.at(-1)]).toEqual([
      0,
      0,
      "Nothing stored. To store it: profile voice --save <the same files>",
    ]);
    expect(printed).toContain('Phrases to review: "in practice"');
  });

  it("stores the measured version with --save and says to review it", async () => {
    const { d, printed, saved } = deps();
    const code = await voiceCommand(d, ["--save", ...FILES]);
    expect([code, saved.length, printed.slice(-1)]).toEqual([
      0,
      1,
      ["Stored version 3 (5 samples, 1 phrase). Review its phrases: profile voice review"],
    ]);
  });

  it("stores nothing when measuring fails, and says why", async () => {
    const { d, printed, saved } = deps();
    const code = await voiceCommand(d, ["--save", ...FILES.slice(0, 3)]);
    expect([code, saved.length, printed]).toEqual([
      1,
      0,
      ["Nothing stored: need 5 to 10 writing samples, got 3"],
    ]);
  });

  it("stores nothing when a file can't be read, naming the file only", async () => {
    const { d, printed, saved } = deps();
    const code = await voiceCommand(d, ["--save", ...FILES.slice(0, 4), "data/missing.txt"]);
    expect([code, saved.length, printed]).toEqual([
      1,
      0,
      ["Nothing stored: missing.txt: not found"],
    ]);
  });
});

describe("profile voice review", () => {
  const newest = { version: 4, phrases: ["in practice", "ship it"], reviewed: false };

  it("lists the newest version's phrases and how to decide them", async () => {
    const { d, printed, reviews } = deps({}, newest);
    const code = await voiceCommand(d, ["review"]);
    expect([code, reviews.length, printed]).toEqual([
      0,
      0,
      [
        "Version 4, not reviewed yet. Phrases to decide:",
        '  "in practice"',
        '  "ship it"',
        'Decide every one: profile voice review --keep "<phrase,phrase>" --drop "<phrase,phrase>"',
      ],
    ]);
  });

  it("stores a decision on every phrase", async () => {
    const { d, printed, reviews } = deps({}, newest);
    const code = await voiceCommand(d, ["review", "--keep", "in practice", "--drop", "ship it"]);
    expect([code, reviews, printed]).toEqual([
      0,
      [{ version: 4, keep: ["in practice"], drop: ["ship it"] }],
      ["Version 4 reviewed: 1 kept, 1 dropped. Drafting uses it from now on."],
    ]);
  });

  it("stores nothing when a phrase is left undecided or isn't in the version", async () => {
    const { d, printed, reviews } = deps({}, newest);
    const missing = await voiceCommand(d, ["review", "--keep", "in practice"]);
    const unknown = await voiceCommand(d, ["review", "--keep", "in practice,ship it,other"]);
    expect([missing, unknown, reviews.length, printed]).toEqual([
      1,
      1,
      0,
      ['Nothing stored. Not decided: "ship it".', 'Nothing stored. Not in version 4: "other".'],
    ]);
  });

  it("reviews a version with no phrases by itself, since there is nothing to decide", async () => {
    const { d, printed, reviews } = deps({}, { version: 2, phrases: [], reviewed: false });
    const code = await voiceCommand(d, ["review"]);
    expect([code, reviews, printed]).toEqual([
      0,
      [{ version: 2, keep: [], drop: [] }],
      ["Version 2 has no phrases to decide; it's reviewed. Drafting uses it from now on."],
    ]);
  });

  it("says when there is no version yet", async () => {
    const { d, printed } = deps();
    expect([await voiceCommand(d, ["review"]), printed]).toEqual([
      1,
      ["No voice profile yet. Run: profile voice --save data/<file> … (5 to 10 samples)"],
    ]);
  });
});

describe("usage", () => {
  it("prints its own usage line for anything else", async () => {
    const { d, printed } = deps();
    expect([
      await voiceCommand(d, []),
      await voiceCommand(d, ["review", "--keep"]),
      printed,
    ]).toEqual([1, 1, [VOICE_USAGE, VOICE_USAGE]]);
  });
});
