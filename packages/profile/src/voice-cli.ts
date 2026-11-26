import type { VoiceMeasures } from "@northstar/db";
import { measureVoice, renderVoiceGuide } from "./voice/measure.js";

// `profile voice [--save] <file> …` and `profile voice review [--keep …] [--drop …]` (NS-222,
// ANS-007): measure Paul's writing samples into a voice profile, store it when he says so, and
// decide which of its phrases drafting may use. Paul only: the samples and phrases are his
// writing, shown back to him in his terminal; counts only go anywhere else.

type Newest = { version: number; phrases: string[]; reviewed: boolean } | null;

export type VoiceCliDeps = {
  print: (line: string) => void;
  // A sample's text (fileToText). Its errors name the file, never its contents.
  readSample: (path: string) => Promise<string>;
  saveVoiceProfile: (measures: VoiceMeasures) => Promise<{ version: number }>;
  readNewestVoice: () => Promise<Newest>;
  // packages/db's Result: only `ok` is read.
  reviewVoiceProfile: (input: {
    version: number;
    keep: string[];
    drop: string[];
  }) => Promise<{ ok: true } | { ok: false; error: { kind: string } }>;
};

export const VOICE_USAGE =
  'usage: profile voice [--save] <file> <file> … (5 to 10 samples) | profile voice review [--keep "<phrase,phrase>"] [--drop "<phrase,phrase>"]';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const quoted = (phrases: readonly string[]) => phrases.map((p) => `"${p}"`).join(", ");

export async function voiceCommand(deps: VoiceCliDeps, args: string[]): Promise<number> {
  if (args[0] === "review") {
    const decision = parseDecision(args.slice(1));
    if (decision) return reviewCommand(deps, decision);
  } else {
    const save = args[0] === "--save";
    const files = save ? args.slice(1) : args;
    // A file can't start with "--": a mistyped flag is not a sample.
    if (files.length > 0 && files.every((f) => !f.startsWith("--"))) {
      return measureCommand(deps, files, save);
    }
  }
  deps.print(VOICE_USAGE);
  return 1;
}

// Measures the samples; stores the version only with --save (Paul's confirmation).
async function measureCommand(deps: VoiceCliDeps, files: string[], save: boolean) {
  let samples: string[];
  try {
    samples = await Promise.all(files.map((f) => deps.readSample(f)));
  } catch (error) {
    // fileToText's message names the file only.
    deps.print(
      `Nothing stored: ${error instanceof Error ? error.message : "a file can't be read"}`,
    );
    return 1;
  }
  const measured = measureVoice(samples);
  if (!measured.ok) {
    deps.print(`Nothing stored: ${measured.problem}`);
    return 1;
  }
  const profile = measured.profile;
  if (!save) {
    for (const line of renderVoiceGuide(profile).split("\n")) deps.print(line);
    deps.print(
      profile.phrases.length > 0
        ? `Phrases to review: ${quoted(profile.phrases)}`
        : "No repeated phrases to review.",
    );
    deps.print("Nothing stored. To store it: profile voice --save <the same files>");
    return 0;
  }
  const { version } = await deps.saveVoiceProfile(profile);
  deps.print(
    `Stored version ${version} (${plural(profile.samples, "sample")}, ${plural(profile.phrases.length, "phrase")}). Review its phrases: profile voice review`,
  );
  return 0;
}

type Decision = { keep: string[]; drop: string[]; given: boolean };

// `--keep a,b` and `--drop c`, each at most once, each with a value; none means "list".
function parseDecision(flags: string[]): Decision | null {
  const out: Decision = { keep: [], drop: [], given: false };
  const seen = new Set<string>();
  for (let i = 0; i < flags.length; i += 2) {
    const flag = flags[i];
    const value = flags[i + 1];
    if ((flag !== "--keep" && flag !== "--drop") || value === undefined || seen.has(flag)) {
      return null;
    }
    seen.add(flag);
    const list = value
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (flag === "--keep") out.keep = list;
    else out.drop = list;
    out.given = true;
  }
  return out;
}

async function reviewCommand(deps: VoiceCliDeps, decision: Decision): Promise<number> {
  const newest = await deps.readNewestVoice();
  if (newest === null) {
    deps.print("No voice profile yet. Run: profile voice --save data/<file> … (5 to 10 samples)");
    return 1;
  }
  const { version, phrases } = newest;
  // Nothing to decide: `review` alone records the review.
  if (!decision.given && phrases.length === 0) {
    return storeReview(
      deps,
      version,
      [],
      [],
      `Version ${version} has no phrases to decide; it's reviewed. Drafting uses it from now on.`,
    );
  }
  if (!decision.given) {
    deps.print(
      `Version ${version}, ${newest.reviewed ? "reviewed (a new decision replaces it)" : "not reviewed yet"}. Phrases to decide:`,
    );
    for (const p of phrases) deps.print(`  "${p}"`);
    deps.print(
      'Decide every one: profile voice review --keep "<phrase,phrase>" --drop "<phrase,phrase>"',
    );
    return 0;
  }
  // Checked here first so Paul is told exactly what to fix; the store checks again.
  const decided = [...decision.keep, ...decision.drop];
  const unknown = decided.filter((p) => !phrases.includes(p));
  const twice = decided.filter((p, i) => decided.indexOf(p) !== i);
  const undecided = phrases.filter((p) => !decided.includes(p));
  const problem =
    unknown.length > 0
      ? `Not in version ${version}: ${quoted(unknown)}.`
      : twice.length > 0
        ? `Named twice: ${quoted([...new Set(twice)])}.`
        : undecided.length > 0
          ? `Not decided: ${quoted(undecided)}.`
          : null;
  if (problem) {
    deps.print(`Nothing stored. ${problem}`);
    return 1;
  }
  return storeReview(
    deps,
    version,
    decision.keep,
    decision.drop,
    `Version ${version} reviewed: ${decision.keep.length} kept, ${decision.drop.length} dropped. Drafting uses it from now on.`,
  );
}

async function storeReview(
  deps: VoiceCliDeps,
  version: number,
  keep: string[],
  drop: string[],
  done: string,
): Promise<number> {
  const result = await deps.reviewVoiceProfile({ version, keep, drop });
  if (!result.ok) {
    // A newer version was saved meanwhile, or the phrases changed: list them again.
    deps.print("Nothing stored: the newest version changed. Run: profile voice review");
    return 1;
  }
  deps.print(done);
  return 0;
}
