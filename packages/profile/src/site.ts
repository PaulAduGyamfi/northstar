import { createHash } from "node:crypto";
import type { ProfileImportInput } from "@northstar/db";
import { err, ok, type Result } from "@northstar/domain";

// Paul's personal site → profile graph (NS-209, CPG-001). Paul saves the site's text into a file
// himself: nothing is fetched or crawled. Plain code, no model: every atom is one line of the
// file, verbatim, under its project's heading, with the project's link as its evidence.
//
// The format:
//   ## Ledgerline
//   Link: https://example.com/ledgerline
//   - Built a budgeting app used by 40 testers
//   Shipped weekly releases for 12 weeks

type Extract = ProfileImportInput["extract"];

// `line` is the file's line, or 0 for a problem with the import as a whole.
export type SiteProblem = { line: number; problem: string };

const MAX_LINE = 500;
const CONTROL = /\p{Cc}/u;
const HEADING = /^##\s+(.+)$/;
const LINK = /^link:\s*(\S+)\s*$/i;

function httpsLink(raw: string): string | null {
  if (raw.length > 300 || !raw.startsWith("https://") || CONTROL.test(raw)) return null;
  try {
    const url = new URL(raw);
    return url.username === "" && url.password === "" ? raw : null;
  } catch {
    return null;
  }
}

type Project = { title: string; line: number; link: string | null; atoms: string[] };

// Reads Paul's file. Any problem refuses the whole file, naming each line, so nothing half-read
// is ever stored.
export function parseSiteText(
  text: string,
): Result<{ extract: Extract; textSha256: string; projects: number }, SiteProblem[]> {
  const problems: SiteProblem[] = [];
  const projects: Project[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    if (trimmed === "") return;
    const heading = HEADING.exec(trimmed);
    if (heading) {
      const title = (heading[1] ?? "").trim();
      if (title.length > 200 || CONTROL.test(title)) {
        problems.push({ line, problem: "a project heading must be at most 200 characters" });
      }
      projects.push({ title, line, link: null, atoms: [] });
      return;
    }
    // "#", "###" or a bare "##" isn't a project heading: say so rather than store it as a claim.
    if (trimmed.startsWith("#")) {
      problems.push({ line, problem: 'only "## " followed by a name starts a project' });
      return;
    }
    const current = projects.at(-1);
    if (current === undefined) {
      problems.push({ line, problem: "a line comes before any ## project heading" });
      return;
    }
    const link = LINK.exec(trimmed);
    if (link) {
      const parsed = httpsLink(link[1] ?? "");
      if (parsed === null)
        problems.push({ line, problem: "the link must be https, with no user name" });
      else if (current.link !== null) problems.push({ line, problem: "a project has one link" });
      else current.link = parsed;
      return;
    }
    // A list marker isn't part of the claim; the rest of the line is, verbatim.
    const body = trimmed.replace(/^[-*]\s+/, "");
    if (body.length > MAX_LINE) {
      problems.push({ line, problem: `a line must be at most ${MAX_LINE} characters` });
      return;
    }
    if (CONTROL.test(body)) {
      problems.push({ line, problem: "a line can't hold a tab or other control character" });
      return;
    }
    current.atoms.push(body);
  });
  for (const p of projects) {
    if (p.atoms.length === 0) problems.push({ line: p.line, problem: "a project needs a line" });
  }
  if (projects.length === 0 && problems.length === 0) {
    problems.push({ line: 1, problem: "the file has no ## project headings" });
  }
  if (problems.length > 0) return err(problems.sort((a, b) => a.line - b.line));

  const extract: Extract = {
    roles: [],
    education: [],
    atoms: projects.flatMap((p) =>
      p.atoms.map((a) => ({
        // Site projects aren't employment: no role.
        roleKey: null,
        what: a,
        how: [],
        impact: null,
        scope: null,
        startMonth: null,
        endMonth: null,
        sourceQuote: a,
        evidenceLink: p.link,
      })),
    ),
    skills: [],
    certifications: [],
    // Each project's link, labelled with the project's own heading.
    links: projects.flatMap((p) => (p.link === null ? [] : [{ label: p.title, url: p.link }])),
  };
  const bad = checkSiteProvenance(extract, text);
  if (bad.length > 0) return err(bad);
  return ok({
    extract,
    textSha256: createHash("sha256").update(text).digest("hex"),
    projects: projects.length,
  });
}

// The deterministic provenance check (ADR-0004): every atom's quote is one line of Paul's file
// (after its list marker), and every link is in the file. The parser builds them that way; this
// proves it, so a later change to the parser can't store words the site never had.
export function checkSiteProvenance(extract: Extract, text: string): SiteProblem[] {
  const lines = new Set(
    text
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/^[-*]\s+/, ""))
      .filter((l) => l !== ""),
  );
  const out: SiteProblem[] = [];
  extract.atoms.forEach((a, i) => {
    if (a.sourceQuote === "" || !lines.has(a.sourceQuote) || a.what !== a.sourceQuote) {
      out.push({ line: 0, problem: `atom ${i + 1} isn't a line of the file` });
    }
  });
  for (const link of extract.links) {
    if (!text.includes(link.url) || !text.includes(link.label)) {
      out.push({ line: 0, problem: "a link isn't in the file" });
    }
  }
  return out;
}
