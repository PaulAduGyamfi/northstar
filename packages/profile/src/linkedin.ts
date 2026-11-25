import { createHash } from "node:crypto";
import type { ProfileImportInput } from "@northstar/db";
import { err, ok, type Result } from "@northstar/domain";

// Paul's LinkedIn data export → profile graph (NS-133, CPG-001). The official "Get a copy of your
// data" archive, unzipped into data/ by Paul: never scraping. Plain code, no model: every field
// is read from a named CSV column, and every atom is one Description line, verbatim.

// RFC 4180: comma-separated, fields in double quotes may hold commas, newlines and "" for a
// quote. CRLF or LF line ends; a final newline is optional; blank lines are skipped.
export function parseCsv(text: string): Result<string[][], "unclosed_quote"> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  // A leading byte-order mark is not part of the first header.
  const src = text.startsWith("﻿") ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (quoted) return err("unclosed_quote");
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return ok(rows);
}

// The export's files Paul points the CLI at. Positions.csv is required; the others are optional.
export type LinkedinFiles = { positions: string; education?: string; skills?: string };

export type LinkedinProblem =
  | { kind: "bad_csv"; file: string }
  | { kind: "missing_header"; file: string; header: string }
  | { kind: "quote_not_in_description"; position: number }
  | { kind: "role_not_its_row"; position: number }
  | { kind: "no_positions" };

type Extract = ProfileImportInput["extract"];

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

// A month by its full name or its three-letter abbreviation ("Sep", "Sept." too), exactly.
function monthNumber(word: string): number | null {
  const w = word.toLowerCase().replace(/\.$/, "");
  const i = MONTHS.findIndex(
    (m) => m === w || m.slice(0, 3) === w || (m === "september" && w === "sept"),
  );
  return i >= 0 ? i + 1 : null;
}

// "Mar 2021" → "2021-03", "2021" → "2021"; anything else → null (not stated, never guessed).
export function linkedinMonth(raw: string): string | null {
  const v = raw.trim();
  if (/^\d{4}$/.test(v)) return v;
  const m = /^(\S+) (\d{4})$/.exec(v);
  const month = m ? monthNumber(m[1] ?? "") : null;
  return m && month !== null ? `${m[2]}-${String(month).padStart(2, "0")}` : null;
}

// A table read by header name, so column order doesn't matter.
function table(
  file: string,
  text: string,
  required: string[],
): Result<Record<string, string>[], LinkedinProblem> {
  const parsed = parseCsv(text);
  if (!parsed.ok) return err({ kind: "bad_csv", file });
  const [header = [], ...rows] = parsed.value;
  const names = header.map((h) => h.trim());
  for (const r of required) {
    if (!names.includes(r)) return err({ kind: "missing_header", file, header: r });
  }
  return ok(
    rows.map((cells) => Object.fromEntries(names.map((n, i) => [n, (cells[i] ?? "").trim()]))),
  );
}

// One Description line per atom: bullet marks and surrounding spaces off, empty lines dropped.
function descriptionLines(description: string): string[] {
  return (
    description
      .split(/\r?\n/)
      // A round bullet may touch its text ("•Built"); a dash or star needs a space after it, so a
      // line starting with "-5%" keeps its minus sign.
      .map((l) => l.replace(/^\s*(?:[•‣◦·]\s*|[-*]\s+)?/u, "").trim())
      // A line of only punctuation ("-", "***") says nothing.
      .filter((l) => /[\p{L}\p{N}]/u.test(l))
  );
}

// The export → the same extract shape the resume import stores, plus the files' combined hash
// (so an unchanged export is a no-op). Refuses the whole export on any problem.
export function parseLinkedinExport(
  files: LinkedinFiles,
): Result<{ extract: Extract; textSha256: string }, LinkedinProblem> {
  const positions = table("Positions.csv", files.positions, [
    "Company Name",
    "Title",
    "Description",
    "Started On",
    "Finished On",
  ]);
  if (!positions.ok) return positions;
  if (positions.value.length === 0) return err({ kind: "no_positions" });

  const extract: Extract = {
    roles: [],
    education: [],
    atoms: [],
    skills: [],
    certifications: [],
    links: [],
  };
  positions.value.forEach((p, i) => {
    const key = `li${i}`;
    const end = linkedinMonth(p["Finished On"] ?? "");
    extract.roles.push({
      key,
      employer: p["Company Name"] ?? "",
      title: p.Title ?? "",
      startMonth: linkedinMonth(p["Started On"] ?? ""),
      endMonth: end,
      // No end date written means the position is ongoing.
      current: (p["Finished On"] ?? "") === "",
    });
    for (const line of descriptionLines(p.Description ?? "")) {
      extract.atoms.push({
        roleKey: key,
        what: line,
        how: [],
        impact: null,
        scope: null,
        startMonth: null,
        endMonth: null,
        sourceQuote: line,
        evidenceLink: null,
      });
    }
  });

  if (files.education !== undefined) {
    const edu = table("Education.csv", files.education, ["School Name"]);
    if (!edu.ok) return edu;
    for (const e of edu.value) {
      extract.education.push({
        school: e["School Name"] ?? "",
        degree: e["Degree Name"] || null,
        field: null,
        startMonth: linkedinMonth(e["Start Date"] ?? ""),
        endMonth: linkedinMonth(e["End Date"] ?? ""),
      });
    }
  }
  if (files.skills !== undefined) {
    const skills = table("Skills.csv", files.skills, ["Name"]);
    if (!skills.ok) return skills;
    extract.skills = skills.value.map((s) => s.Name ?? "").filter((n) => n !== "");
  }

  const problems = checkLinkedinProvenance(extract, positions.value);
  if (problems.length > 0) return err(problems[0] as LinkedinProblem);

  // Each file's text, in a fixed order with its name, so moving a file between slots changes it.
  const hash = createHash("sha256");
  for (const [name, text] of [
    ["Positions.csv", files.positions],
    ["Education.csv", files.education ?? ""],
    ["Skills.csv", files.skills ?? ""],
  ] as const) {
    hash.update(`${name}\n${text}\n`);
  }
  return ok({ extract, textSha256: hash.digest("hex") });
}

// The deterministic provenance check (ADR-0004), run on the extract before it is stored: every
// role's employer and title are its own row's fields, and every atom's quote sits verbatim in its
// own position's Description. The parser above builds them that way; this check proves it, so a
// later change to the parser (trimming, joining lines, cleaning text) can't store a line LinkedIn
// never had without the import refusing.
export function checkLinkedinProvenance(
  extract: Extract,
  positions: Record<string, string>[],
): LinkedinProblem[] {
  const out: LinkedinProblem[] = [];
  const indexOf = (key: string | null) => {
    const m = /^li(\d+)$/.exec(key ?? "");
    return m ? Number(m[1]) : -1;
  };
  extract.roles.forEach((role) => {
    const i = indexOf(role.key);
    const row = positions[i];
    if (!row || row["Company Name"] !== role.employer || row.Title !== role.title) {
      out.push({ kind: "role_not_its_row", position: i });
    }
  });
  extract.atoms.forEach((atom) => {
    const i = indexOf(atom.roleKey);
    const description = positions[i]?.Description ?? "";
    if (atom.sourceQuote === "" || !description.includes(atom.sourceQuote)) {
      out.push({ kind: "quote_not_in_description", position: i });
    }
  });
  return out;
}

// A problem in plain words for Paul's terminal (names files and headers, never row text).
export function describeLinkedinProblem(p: LinkedinProblem): string {
  switch (p.kind) {
    case "bad_csv":
      return `${p.file} isn't valid CSV (a quote is never closed)`;
    case "missing_header":
      return `${p.file} has no "${p.header}" column`;
    case "quote_not_in_description":
      return `position ${p.position + 1}: a line isn't in its Description`;
    case "role_not_its_row":
      return `position ${p.position + 1}: its company or title isn't the row's own`;
    case "no_positions":
      return "Positions.csv has no positions";
  }
}
