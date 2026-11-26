import { parseGrowthTrack } from "@northstar/domain";

// Paul's growth tracks file (NS-210, GRW-001/002): one track per line, checked by plain code.
//
//   key | name | type | status | priority [| target YYYY-MM-DD] [| untouched <days>] [| next <minutes> <title>]
//
// e.g. `aws-saa | AWS Solutions Architect | cert | active | 4 | target 2027-02-01 | next 60 Practice exam 1`.
// Blank lines and lines starting with `#` are skipped. A file with any bad line stores nothing.

export type TrackLine = {
  key: string;
  name: string;
  type: "project" | "course" | "cert" | "skill";
  status: "active" | "paused" | "backlogged" | "done";
  priority: number;
  // YYYY-MM-DD, or null.
  target: string | null;
  untouchedDays: number;
  next: { title: string; minutes: number } | null;
};

export type TrackProblem = { line: number; problem: string };

const KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CONTROL = /\p{Cc}/u;
const MAX_TRACKS = 50;

// A real calendar day (2026-02-30 isn't).
function realDay(d: string): boolean {
  if (!DAY.test(d)) return false;
  const ms = Date.parse(`${d}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(d);
}

function parseLine(raw: string): TrackLine | string {
  if (CONTROL.test(raw)) return "a line can't hold a tab or other control character";
  const parts = raw.split("|").map((p) => p.trim());
  if (parts.length < 5) return "a track is: key | name | type | status | priority [| …]";
  const [key = "", name = "", type = "", status = "", priority = "", ...options] = parts;
  if (!KEY.test(key)) return "the key must be 1–40 lowercase letters, digits or dashes";
  if (name.length === 0 || name.length > 120) return "the name must be 1 to 120 characters";
  if (!/^[1-5]$/.test(priority)) return "the priority must be 1 to 5";
  let target: string | null = null;
  let untouchedDays = 7;
  let next: TrackLine["next"] = null;
  for (const option of options) {
    const [word = "", ...rest] = option.split(/\s+/);
    const value = rest.join(" ");
    if (word === "target" && realDay(value) && target === null) target = value;
    else if (word === "untouched" && /^\d{1,3}$/.test(value)) untouchedDays = Number(value);
    else if (
      word === "next" &&
      /^\d{1,4}$/.test(rest[0] ?? "") &&
      rest.length > 1 &&
      next === null
    ) {
      next = { minutes: Number(rest[0]), title: rest.slice(1).join(" ") };
    } else {
      return `"${word}" isn't an option: use target YYYY-MM-DD, untouched <days> or next <minutes> <title>`;
    }
  }
  // The domain's own check of every field (type, status, ranges), so the file and the planner
  // agree. Its error names fields, never values.
  const checked = parseGrowthTrack({
    id: key,
    name,
    type,
    status,
    priority: Number(priority),
    targetDate: target === null ? null : new Date(`${target}T00:00:00Z`),
    lastTouchedAt: null,
    untouchedDays,
    nextAction: next,
  });
  if (!checked.ok) return `check ${checked.error.fields.join(", ")}`;
  return {
    key,
    name,
    type: checked.value.type,
    status: checked.value.status,
    priority: checked.value.priority,
    target,
    untouchedDays: checked.value.untouchedDays,
    next,
  };
}

export function parseGrowthTracks(
  text: string,
): { ok: true; value: TrackLine[] } | { ok: false; error: TrackProblem[] } {
  const problems: TrackProblem[] = [];
  const tracks: TrackLine[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const parsed = parseLine(trimmed);
    if (typeof parsed === "string") {
      problems.push({ line, problem: parsed });
      return;
    }
    if (seen.has(parsed.key)) {
      problems.push({ line, problem: "this key is already used above" });
      return;
    }
    seen.add(parsed.key);
    tracks.push(parsed);
  });
  if (tracks.length === 0 && problems.length === 0) {
    problems.push({ line: 1, problem: "the file has no tracks" });
  }
  if (tracks.length > MAX_TRACKS)
    problems.push({ line: 1, problem: `at most ${MAX_TRACKS} tracks` });
  return problems.length > 0 ? { ok: false, error: problems } : { ok: true, value: tracks };
}
