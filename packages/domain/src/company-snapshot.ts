// The Research Service's company snapshot (NS-283 slice 1, CAL-005), plain code with no I/O and
// no model. It reads only what the caller hands it from storage: the company's name and its saved
// jobs. Posting text is untrusted (NFR-SEC-004): it is only ever quoted, verbatim, with the job it
// came from, and never read as an instruction. Every line cites its source (ADR-0004), and
// `checkSnapshot` refuses a line that cites nothing, cites an unknown job or doesn't quote it.

// Where a line's words come from: a saved job, a resume atom or an approved story.
export type Citation = { source: "job" | "atom" | "story"; id: string };

export type SnapshotLine = { text: string; cites: Citation[] };

export type SnapshotJob = {
  id: string;
  title: string;
  description: string | null;
  requirements: readonly string[];
  // When the posting went up, else null (sorted after dated jobs).
  postedAt: Date | null;
  // True once posting liveness closed it (NS-173): it is no open role.
  closed: boolean;
};

export type CompanySnapshot = {
  company: string;
  // Sentences from a posting that name the company, verbatim.
  about: SnapshotLine[];
  // The open jobs' titles, freshest first.
  roles: SnapshotLine[];
  // Technologies from STACK_TERMS the postings name, most-named first.
  stack: SnapshotLine[];
};

export const MAX_ABOUT_LINES = 2;
export const MAX_ROLE_LINES = 10;
export const MAX_STACK_LINES = 15;
// Cites per stack line: enough to show where it comes from, bounded for the page.
export const MAX_STACK_CITES = 5;
export const MAX_QUOTE_LENGTH = 300;

// Technologies a stack line may name. A fixed list in code, so a posting can never put its own
// words in a stack line: the posting only decides which of these appear.
export const STACK_TERMS: readonly string[] = [
  "TypeScript",
  "JavaScript",
  "Node.js",
  "React",
  "Next.js",
  "Vue",
  "Angular",
  "Python",
  "Django",
  "Flask",
  "FastAPI",
  "Go",
  "Rust",
  "Java",
  "Kotlin",
  "Scala",
  "Swift",
  "Ruby",
  "Rails",
  "PHP",
  "C#",
  ".NET",
  "C++",
  "Elixir",
  "PostgreSQL",
  "Postgres",
  "MySQL",
  "SQLite",
  "MongoDB",
  "Redis",
  "Elasticsearch",
  "Kafka",
  "RabbitMQ",
  "Snowflake",
  "BigQuery",
  "Spark",
  "Airflow",
  "dbt",
  "GraphQL",
  "gRPC",
  "AWS",
  "GCP",
  "Azure",
  "Kubernetes",
  "Docker",
  "Terraform",
  "Temporal",
  "Linux",
  "PyTorch",
  "TensorFlow",
];

// Characters a quote may never carry: controls, invisible formatting (direction marks,
// zero-width spaces), private-use and unassigned code points, line and paragraph separators, and
// blank-looking characters (Hangul fillers, the braille blank). A sentence holding one is skipped:
// it could hide words from Paul on the page.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}ᅟᅠㅤﾠ⠀]/u;

// Characters that continue a name: "Go" isn't in "Google", "C" isn't in "C#".
const NAME_CHAR = "A-Za-z0-9+#";
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// True when `term` appears in `text` as a whole name, ignoring case unless `exactCase` (the Fit
// Score's rule, with exact case for words a sentence uses in other senses).
export function namesWhole(text: string, term: string, exactCase = false): boolean {
  const t = term.trim();
  if (t === "") return false;
  const pattern = `(?<![${NAME_CHAR}])${escapeRegex(t)}(?![${NAME_CHAR}])`;
  return new RegExp(pattern, exactCase ? "" : "i").test(text);
}

// Stack terms that are also everyday words ("go live", "rust", "a temporal gap"): a posting names
// the technology only when it writes the capital.
const EXACT_CASE_TERMS = new Set(["Go", "Rust", "Swift", "Ruby", "Rails", "Spark", "Temporal"]);

// A quote fit to show: no hidden characters, not empty, not too long.
export function quotable(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= MAX_QUOTE_LENGTH && !HIDDEN.test(t);
}

// A description's sentences, each exactly as written (so a quote is a verbatim substring).
function sentences(text: string): string[] {
  return (text.match(/[^.!?\n]+[.!?]?/g) ?? []).map((s) => s.trim()).filter((s) => s !== "");
}

// Freshest first; undated jobs after dated ones; then by id so the order never varies.
function byFreshness(a: SnapshotJob, b: SnapshotJob): number {
  const at = a.postedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bt = b.postedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (at !== bt) return bt - at;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const jobCite = (id: string): Citation => ({ source: "job", id });

export function buildCompanySnapshot(input: {
  company: string;
  jobs: readonly SnapshotJob[];
}): CompanySnapshot {
  const jobs = [...input.jobs].sort(byFreshness);
  const open = jobs.filter((j) => !j.closed);

  // About: sentences that name the company, from the freshest postings first, once each.
  const about: SnapshotLine[] = [];
  const seen = new Set<string>();
  const company = input.company.trim();
  for (const job of jobs) {
    if (company === "" || about.length >= MAX_ABOUT_LINES) break;
    for (const s of sentences(job.description ?? "")) {
      if (about.length >= MAX_ABOUT_LINES) break;
      if (!namesWhole(s, company) || !quotable(s) || seen.has(s)) continue;
      seen.add(s);
      about.push({ text: s, cites: [jobCite(job.id)] });
    }
  }

  // Open roles: each open job's title as written.
  const roles: SnapshotLine[] = open
    .filter((j) => quotable(j.title))
    .slice(0, MAX_ROLE_LINES)
    .map((j) => ({ text: j.title.trim(), cites: [jobCite(j.id)] }));

  // Stack: the fixed terms the postings name, by how many jobs name each (then list order).
  const stack = STACK_TERMS.map((term, order) => ({
    term,
    order,
    jobs: jobs.filter((j) => jobNames(j, term)),
  }))
    .filter((s) => s.jobs.length > 0)
    .sort((a, b) => b.jobs.length - a.jobs.length || a.order - b.order)
    .slice(0, MAX_STACK_LINES)
    .map((s) => ({
      text: s.term,
      cites: s.jobs.slice(0, MAX_STACK_CITES).map((j) => jobCite(j.id)),
    }));

  return { company, about, roles, stack };
}

// True when the job's requirements or description name the term.
function jobNames(job: Pick<SnapshotJob, "description" | "requirements">, term: string): boolean {
  const exact = EXACT_CASE_TERMS.has(term);
  return (
    job.requirements.some((r) => namesWhole(r, term, exact)) ||
    namesWhole(job.description ?? "", term, exact)
  );
}

export type SnapshotProblem = {
  section: "about" | "roles" | "stack";
  index: number;
  reason: "uncited" | "unknown_source" | "not_verbatim" | "not_quotable";
};

// Every snapshot line must cite a given job and say only what that job says: an about line is a
// verbatim sentence of a cited job's description, a role line a cited job's title, a stack line
// a STACK_TERMS term every cited job names. Plain code, no model (ADR-0004).
export function checkSnapshot(
  snapshot: CompanySnapshot,
  jobs: readonly SnapshotJob[],
): SnapshotProblem[] {
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const problems: SnapshotProblem[] = [];
  const sections = ["about", "roles", "stack"] as const;
  for (const section of sections) {
    snapshot[section].forEach((line, index) => {
      const reason = snapshotLineProblem(section, line, byId);
      if (reason) problems.push({ section, index, reason });
    });
  }
  return problems;
}

// What is wrong with one snapshot line, or null. Shared with the brief's check.
export function snapshotLineProblem(
  section: "about" | "roles" | "stack",
  line: SnapshotLine,
  jobs: ReadonlyMap<string, SnapshotJob>,
): SnapshotProblem["reason"] | null {
  if (line.cites.length === 0) return "uncited";
  const cited: SnapshotJob[] = [];
  for (const c of line.cites) {
    const job = c.source === "job" ? jobs.get(c.id) : undefined;
    if (!job) return "unknown_source";
    cited.push(job);
  }
  if (section !== "stack" && !quotable(line.text)) return "not_quotable";
  const backed = (job: SnapshotJob): boolean => {
    if (section === "about") return sentences(job.description ?? "").includes(line.text);
    if (section === "roles") return job.title.trim() === line.text;
    return STACK_TERMS.includes(line.text) && jobNames(job, line.text);
  };
  // An about or role line needs one cited job that says it; a stack line, every cited job.
  const ok = section === "stack" ? cited.every(backed) : cited.some(backed);
  return ok ? null : "not_verbatim";
}
