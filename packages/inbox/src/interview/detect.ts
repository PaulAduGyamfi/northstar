import { inWindow, ownDomains } from "../link/match.js";
import type { MAIL_KINDS } from "../mail-schema.js";
import { underDomain } from "../prefilter.js";

// Interview detection (CAL-002, NS-169). Plain code, no model: a calendar event is an interview
// when its title says so and its organizer or attendees come from exactly one open application's
// own company domains. A calendar invite carries no authentication Northstar can check, so every
// detection is a proposal for Paul to confirm (`confirmed: false`) and never changes a status.

export type CalendarEvent = {
  id: string;
  title: string;
  description: string | null;
  start: Date;
  end: Date;
  status: "confirmed" | "tentative" | "cancelled";
  organizer: string | null;
  attendees: readonly string[];
};

// What detection may know about an open application (a subset of matchMail's LinkCandidate).
export type InterviewCandidate = {
  applicationId: string;
  // The company's own domains. Shared ATS and freemail domains never count.
  companyDomains: readonly string[];
  activeFrom: Date;
  activeUntil: Date | null;
};

export type InterviewFormat =
  | "phone_screen"
  | "technical"
  | "system_design"
  | "behavioral"
  | "onsite"
  | "other";

export type InterviewDetection =
  | {
      kind: "interview";
      applicationId: string;
      format: InterviewFormat;
      start: Date;
      end: Date;
      // Attendee addresses under the matched company's domains. Held in memory only here.
      interviewers: string[];
      // Always false: an invite isn't authenticated, so Paul confirms it.
      confirmed: false;
    }
  | { kind: "ambiguous"; candidateIds: string[] }
  | { kind: "none"; reason: "cancelled" | "not_interview" | "no_match" };

// Title words that make an event an interview. Matched on the title only: a description often
// quotes other meetings, and a lunch invite that mentions "interview" in its notes isn't one.
const INTERVIEW =
  /\binterview|\bphone screen|\bscreening call|\bintro call\b|\btake-?home review\b|\brecruiter (?:call|chat|screen)|\btechnical\b|\bcoding\b|\bpairing\b|\bsystem design\b|\bbehaviou?ral\b|\bon-?site\b|\bfinal round\b|\bpanel\b|\bhiring manager\b/i;

// Format words, most specific first: "Technical system design interview" is system design.
const FORMATS: readonly [InterviewFormat, RegExp][] = [
  ["system_design", /\bsystem design\b/i],
  ["behavioral", /\bbehaviou?ral\b/i],
  ["technical", /\btechnical\b|\bcoding\b|\bpairing\b|\btake-?home review\b/i],
  ["onsite", /\bon-?site\b|\bfinal round\b|\bpanel\b/i],
  [
    "phone_screen",
    /\bphone screen|\bscreening call|\brecruiter (?:call|chat|screen)|\bintro call\b/i,
  ],
];

// An invite's addresses are whatever its author typed. Only a bare `local@domain` with one "@"
// and a plain host name counts; display names, angle brackets and anything stranger are dropped
// before matching, so a crafted string can't end in a company's domain by accident.
const ADDRESS = /^[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

export function bareAddress(raw: string): string | null {
  const address = raw.trim().toLowerCase();
  return ADDRESS.test(address) ? address : null;
}

const domainOf = (address: string): string => address.slice(address.indexOf("@") + 1);

export function interviewFormat(title: string): InterviewFormat {
  return FORMATS.find(([, re]) => re.test(title))?.[0] ?? "other";
}

export function detectInterview(
  event: CalendarEvent,
  candidates: readonly InterviewCandidate[],
): InterviewDetection {
  if (event.status === "cancelled") return { kind: "none", reason: "cancelled" };
  if (!INTERVIEW.test(event.title)) return { kind: "none", reason: "not_interview" };

  // The organizer and attendees are claims the invite's author made, not evidence: hence
  // `confirmed: false` below.
  const attendees = event.attendees.map(bareAddress).filter((a): a is string => a !== null);
  const organizer = event.organizer === null ? null : bareAddress(event.organizer);
  const domains = [...(organizer ? [organizer] : []), ...attendees].map(domainOf);
  const matched = candidates.filter((c) => {
    const own = ownDomains(c);
    return inWindow(c, event.start) && domains.some((d) => own.some((o) => underDomain(d, o)));
  });
  if (matched.length === 0) return { kind: "none", reason: "no_match" };
  if (matched.length > 1) {
    return { kind: "ambiguous", candidateIds: matched.map((c) => c.applicationId) };
  }
  const app = matched[0];
  if (app === undefined) return { kind: "none", reason: "no_match" };
  const own = ownDomains(app);
  return {
    kind: "interview",
    applicationId: app.applicationId,
    format: interviewFormat(event.title),
    start: event.start,
    end: event.end,
    interviewers: attendees.filter((a) => own.some((o) => underDomain(domainOf(a), o))),
    confirmed: false,
  };
}

// A linked job email that asks to set up an interview (CAL-002 from email, NS-164's kinds):
// the application has an interview waiting to be scheduled. Only a deterministic link counts.
export type MailInterview =
  // senderVerified is passed through from matchMail, so a confirm queue can rank by it.
  { kind: "to_schedule"; applicationId: string; senderVerified: boolean } | { kind: "none" };

export function interviewFromMail(
  kind: (typeof MAIL_KINDS)[number],
  link:
    | { kind: "linked"; applicationId: string; senderVerified: boolean }
    | { kind: "queued" }
    | { kind: "skip" },
): MailInterview {
  if (link.kind !== "linked") return { kind: "none" };
  return kind === "interview_request" || kind === "scheduling"
    ? {
        kind: "to_schedule",
        applicationId: link.applicationId,
        senderVerified: link.senderVerified,
      }
    : { kind: "none" };
}
