import { z } from "zod";

// Detected interviews (NS-240 slice 5, CAL-002): the API's list and the plain words the confirm
// page shows. A detection comes from a calendar invite, which isn't authenticated, so it waits for
// Paul's confirm or dismiss and never changes an application's status.

// INTERVIEW_FORMATS in @northstar/domain, copied: the web app holds only its API's shapes.
const FORMATS = [
  "phone_screen",
  "technical",
  "system_design",
  "behavioral",
  "onsite",
  "other",
] as const;
const DECISIONS = ["confirmed", "dismissed"] as const;
export type InterviewDecision = (typeof DECISIONS)[number];

export const InterviewsBody = z.object({
  items: z.array(
    z.object({
      detectionId: z.string(),
      applicationId: z.string(),
      format: z.enum(FORMATS),
      start: z.string(),
      end: z.string(),
      interviewerCount: z.number(),
      decision: z.enum(DECISIONS).nullable(),
      jobTitle: z.string().nullable(),
      company: z.string().nullable(),
    }),
  ),
});
export type InterviewItem = z.infer<typeof InterviewsBody>["items"][number];

const FORMAT_WORDS: Record<InterviewItem["format"], string> = {
  phone_screen: "Phone screen",
  technical: "Technical interview",
  system_design: "System design interview",
  behavioral: "Behavioral interview",
  onsite: "Onsite interview",
  other: "Interview",
};

export const DECISION_LABELS: Record<InterviewDecision, string> = {
  confirmed: "Confirm",
  dismissed: "Dismiss",
};

// One detection in words: what, for which job, when, who, and where it stands.
export function interviewRow(
  item: InterviewItem,
  timeZone?: string,
): { what: string; when: string; who: string; status: string } {
  const job = item.company ?? "a job you applied to";
  const role = item.jobTitle ? ` (${item.jobTitle})` : "";
  const day = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone });
  const who =
    item.interviewerCount === 0
      ? "No interviewers from the company listed"
      : item.interviewerCount === 1
        ? "1 interviewer from the company"
        : `${item.interviewerCount} interviewers from the company`;
  const status =
    item.decision === "confirmed"
      ? "Confirmed"
      : item.decision === "dismissed"
        ? "Dismissed"
        : "Not verified: confirm or dismiss";
  return {
    what: `${FORMAT_WORDS[item.format]} with ${job}${role}`,
    when: `${day.format(new Date(item.start))} to ${time.format(new Date(item.end))}`,
    who,
    status,
  };
}

// What happened after Paul's choice, in words. Neither choice moves the application.
export function decidedMessage(decision: InterviewDecision): string {
  return decision === "confirmed"
    ? "Confirmed. The application's status doesn't change: you move it yourself when you're ready."
    : "Dismissed. Northstar won't ask about this invite again.";
}

// A refused decision, in words.
export function decideProblem(code: unknown): string {
  if (code === "already_decided") return "You already decided this one.";
  if (code === "superseded") return "This interview moved. Decide on the new time below.";
  if (code === "not_found") return "That interview isn't there anymore.";
  return "That didn't work. Try again.";
}

// Waiting detections, then decided ones, each in the API's order (soonest first).
export function waitingFirst(items: readonly InterviewItem[]): {
  waiting: InterviewItem[];
  decided: InterviewItem[];
} {
  return {
    waiting: items.filter((i) => i.decision === null),
    decided: items.filter((i) => i.decision !== null),
  };
}

export const NO_INTERVIEWS =
  "No interviews found on your calendar yet. They show here once Northstar reads your calendar.";
