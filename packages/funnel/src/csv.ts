import { funnelSchema, type ManualRowInput } from "@northstar/db";
import { err, ok, type Result } from "@northstar/domain";

// Paul's tracker export (DX-002): a CSV with columns company, role, applied_on, stage_reached,
// outcome, outcome_on, channel and notes (the last three optional; notes is never read). A file
// with any bad row is refused whole, so a half-read tracker is never stored.

// RFC 4180 CSV: comma-separated, fields may be quoted, "" is a quote inside quotes, and a quoted
// field may hold commas and newlines. Returns rows of raw strings; blank lines are skipped.
export function parseCsv(text: string): string[][] {
  return parseCsvLines(text).map((r) => r.cells);
}

// The same, with the file line each row starts on (blank lines and multi-line fields counted).
export function parseCsvLines(text: string): { cells: string[]; line: number }[] {
  const rows: { cells: string[]; line: number }[] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let start = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") line += 1;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      // \r\n is one line end.
      if (c === "\r" && text[i + 1] === "\n") {
        i++;
        line += 1;
      } else if (c === "\r") line += 1;
      row.push(field);
      if (row.some((f) => f !== "")) rows.push({ cells: row, line: start });
      row = [];
      field = "";
      start = line;
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push({ cells: row, line: start });
  return rows;
}

const REQUIRED = ["company", "role", "applied_on", "stage_reached", "outcome"] as const;
const OPTIONAL = ["outcome_on", "channel", "notes"] as const;

export type TrackerError = { line: number; problem: string };

// A real calendar day: 2026-02-30 is refused.
function isDay(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function parseTracker(text: string): Result<ManualRowInput[], TrackerError[]> {
  // Excel's "CSV UTF-8" starts with a byte-order mark, which would hide the first column's name.
  const [header, ...rows] = parseCsvLines(text.replace(/^\uFEFF/, ""));
  const columns = (header?.cells ?? []).map((h) => h.trim().toLowerCase());
  const errors: TrackerError[] = [];
  for (const c of REQUIRED)
    if (!columns.includes(c)) errors.push({ line: 1, problem: `missing column ${c}` });
  for (const c of columns) {
    if (
      !(REQUIRED as readonly string[]).includes(c) &&
      !(OPTIONAL as readonly string[]).includes(c)
    ) {
      errors.push({ line: 1, problem: `unknown column ${c}` });
    }
  }
  if (errors.length > 0) return err(errors);

  const out: ManualRowInput[] = [];
  for (const { cells, line } of rows) {
    const get = (name: string) => (cells[columns.indexOf(name)] ?? "").trim();
    const problem = validateRow(get);
    if (problem) {
      errors.push({ line, problem });
      continue;
    }
    const outcomeOn = get("outcome_on");
    const channel = get("channel");
    out.push({
      line,
      company: get("company"),
      role: get("role"),
      appliedOn: get("applied_on"),
      stageReached: get("stage_reached") as ManualRowInput["stageReached"],
      outcome: get("outcome") as ManualRowInput["outcome"],
      outcomeOn: outcomeOn === "" ? null : outcomeOn,
      channel: channel === "" ? null : (channel as ManualRowInput["channel"]),
    });
  }
  if (errors.length > 0) return err(errors);
  if (out.length === 0) return err([{ line: 0, problem: "no rows in the file" }]);
  return ok(out);
}

// The first problem with one row, or null. Messages name the column, never the row's values.
function validateRow(get: (name: string) => string): string | null {
  const oneOf = (name: string, values: readonly string[]) =>
    `${name} must be one of ${values.join(", ")}`;
  if (get("company") === "" || get("role") === "") return "company and role can't be empty";
  if (!isDay(get("applied_on"))) return "applied_on must be a real date YYYY-MM-DD";
  const stage = get("stage_reached");
  if (!(funnelSchema.FUNNEL_STAGES as readonly string[]).includes(stage)) {
    return oneOf("stage_reached", funnelSchema.FUNNEL_STAGES);
  }
  const outcome = get("outcome");
  if (!(funnelSchema.FUNNEL_OUTCOMES as readonly string[]).includes(outcome)) {
    return oneOf("outcome", funnelSchema.FUNNEL_OUTCOMES);
  }
  const outcomeOn = get("outcome_on");
  if (outcomeOn !== "" && !isDay(outcomeOn)) return "outcome_on must be a real date YYYY-MM-DD";
  // Same-format ISO days compare correctly as strings.
  if (outcomeOn !== "" && outcomeOn < get("applied_on")) return "outcome_on is before applied_on";
  if (outcome === "offer" && stage !== "offer") return "an offer outcome needs stage_reached offer";
  const channel = get("channel");
  if (channel !== "" && !(funnelSchema.CHANNELS as readonly string[]).includes(channel)) {
    return oneOf("channel", funnelSchema.CHANNELS);
  }
  return null;
}
