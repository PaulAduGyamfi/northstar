import type { MasterResume, MasterRole, TailoredResume } from "./types.js";

// The ATS-safe plain-text resume (NS-117): one column, fixed upper-case headers, `- ` bullets, no
// tables or columns a parser could scramble. The PDF and DOCX renderers (TLR-005) will follow
// the same structure. Employer, title, school, degree and dates come from the master, never from
// the tailored resume (CPG-004).

export const HEADERS = ["SUMMARY", "EXPERIENCE", "PROJECTS", "EDUCATION", "SKILLS"] as const;
export type Header = (typeof HEADERS)[number];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2021-03" → "Mar 2021"; "2017" stays "2017" (a year-only date keeps its precision).
function showMonth(month: string): string {
  const [year, mm] = month.split("-");
  const name = mm === undefined ? undefined : MONTHS[Number(mm) - 1];
  return name ? `${name} ${year}` : (year ?? month);
}

// "Mar 2021 – Present" only when the role is current: an unknown end is shown as nothing.
function dates(role: MasterRole): string {
  const start = role.startMonth ? showMonth(role.startMonth) : null;
  const end = role.isCurrent ? "Present" : role.endMonth ? showMonth(role.endMonth) : null;
  return [start, end].filter((d): d is string => d !== null).join(" – ");
}

const withDates = (head: string, when: string) => (when === "" ? head : `${head} · ${when}`);

export function renderResumeText(resume: TailoredResume, master: MasterResume): string {
  const roles = new Map(master.roles.map((r) => [r.id, r]));
  const blocks: string[][] = [];
  const bullets = (lines: { text: string }[]) => lines.map((l) => `- ${l.text}`);

  if (resume.summary.length > 0) blocks.push(["SUMMARY", ...resume.summary.map((l) => l.text)]);

  const experience: string[] = [];
  for (const section of resume.sections) {
    const role = section.roleId === null ? undefined : roles.get(section.roleId);
    if (!role) continue;
    if (experience.length > 0) experience.push("");
    experience.push(withDates(`${role.title}, ${role.employer}`, dates(role)));
    experience.push(...bullets(section.lines));
  }
  if (experience.length > 0) blocks.push(["EXPERIENCE", ...experience]);

  const projects = resume.sections.filter((s) => s.roleId === null).flatMap((s) => s.lines);
  if (projects.length > 0) blocks.push(["PROJECTS", ...bullets(projects)]);

  if (master.education.length > 0) {
    blocks.push([
      "EDUCATION",
      ...master.education.map((e) => {
        const head = [e.degree, e.field, e.school].filter((x): x is string => !!x).join(", ");
        return withDates(head, e.endMonth ? showMonth(e.endMonth) : "");
      }),
    ]);
  }

  if (resume.skills.length > 0) {
    blocks.push(["SKILLS", resume.skills.map((s) => s.name).join(", ")]);
  }

  return `${blocks.map((b) => b.join("\n")).join("\n\n")}\n`;
}

// The headers a rendered text uses, in order: what the ATS re-parse must find again.
export function headersIn(rendered: string): Header[] {
  const lines = new Set(rendered.split("\n"));
  return HEADERS.filter((h) => lines.has(h));
}
