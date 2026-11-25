import type {
  Channel,
  FunnelMessageRow,
  FunnelOutcome,
  FunnelStage,
  ManualRowInput,
} from "@northstar/db";

// Funnel records (DX-001/002), derived from stored messages and tracker rows by plain code, never a
// model. The same inputs always give the same records, so reruns and review decisions are safe.

export const STAGE_ORDER: readonly FunnelStage[] = [
  "applied",
  "responded",
  "screen",
  "technical",
  "onsite",
  "offer",
];
const rank = (s: FunnelStage) => STAGE_ORDER.indexOf(s);
const maxStage = (a: FunnelStage, b: FunnelStage) => (rank(a) >= rank(b) ? a : b);

const DAY_MS = 86_400_000;
// Messages about the same company and role more than this far apart are separate applications.
export const GROUP_WINDOW_DAYS = 120;
// No message for this long after the last one, with no outcome: ghosted (13-search-diagnostics).
export const GHOST_AFTER_DAYS = 30;
// A tracker row and a Gmail record for the same company and role match within this many days.
export const MERGE_WINDOW_DAYS = 14;

// Lower case, accents and punctuation dropped, a trailing legal suffix removed: "Globex, Inc." and
// "globex" are the same employer. (The same rule as NS-112's employer check, kept here so this
// package doesn't depend on packages/profile.)
const SUFFIXES = new Set(["inc", "incorporated", "llc", "ltd", "corp", "corporation", "co", "plc"]);
export function nameKey(s: string | null): string {
  if (s === null) return "";
  const words = s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  while (words.length > 1 && SUFFIXES.has(words.at(-1) ?? "")) words.pop();
  return words.join(" ");
}

export type FunnelRecord = {
  company: string;
  role: string | null;
  appliedAt: Date;
  stage: FunnelStage;
  outcome: FunnelOutcome;
  outcomeAt: Date | null;
  channel: Channel | null;
  source: "gmail" | "manual" | "both";
};

// A Gmail record while it's being built: its messages, oldest first.
type Group = { messages: FunnelMessageRow[] };

export type Placement =
  | { kind: "existing"; index: number }
  | { kind: "new" }
  | { kind: "ambiguous"; count: number };

// Where one classified message belongs among the groups so far (INB-009 steps 2–3):
// 1. the same Gmail thread; 2. the same company and requisition id; 3. the same company and role
// within GROUP_WINDOW_DAYS; 4. a message with no role joins the one recent group for its company.
// Two or more candidates at the deciding step is ambiguous: the backfill sends it to review.
export function placeMessage(groups: readonly Group[], m: FunnelMessageRow): Placement {
  const pick = (matches: number[]): Placement | null => {
    if (matches.length === 1) return { kind: "existing", index: matches[0] ?? 0 };
    if (matches.length > 1) return { kind: "ambiguous", count: matches.length };
    return null;
  };
  const indexes = (pred: (g: Group) => boolean) => groups.flatMap((g, i) => (pred(g) ? [i] : []));

  const byThread = pick(indexes((g) => g.messages.some((x) => x.threadId === m.threadId)));
  if (byThread) return byThread;

  const company = nameKey(m.company);
  const sameCompany = (g: Group) => g.messages.some((x) => nameKey(x.company) === company);
  if (m.requisition) {
    const req = m.requisition.trim().toLowerCase();
    const byReq = pick(
      indexes(
        (g) =>
          sameCompany(g) && g.messages.some((x) => x.requisition?.trim().toLowerCase() === req),
      ),
    );
    if (byReq) return byReq;
  }
  const recent = (g: Group) => {
    const last = g.messages.at(-1)?.receivedAt.getTime() ?? 0;
    return m.receivedAt.getTime() - last <= GROUP_WINDOW_DAYS * DAY_MS;
  };
  const role = nameKey(m.role);
  if (role !== "") {
    const byRole = pick(
      indexes(
        (g) => sameCompany(g) && recent(g) && g.messages.some((x) => nameKey(x.role) === role),
      ),
    );
    if (byRole) return byRole;
    return { kind: "new" };
  }
  return pick(indexes((g) => sameCompany(g) && recent(g))) ?? { kind: "new" };
}

// The stage one message shows: its stage signal, or "responded" for any reply from a person.
// A rejection or confirmation alone shows nothing beyond "applied": a templated no isn't a
// response (13-search-diagnostics, A → B).
function stageOf(m: FunnelMessageRow): FunnelStage {
  if (m.kind === "offer" || m.stageSignal === "offer") return "offer";
  if (m.stageSignal === "onsite") return "onsite";
  if (m.stageSignal === "technical") return "technical";
  if (m.stageSignal === "screen") return "screen";
  const human = [
    "interview_request",
    "scheduling",
    "assessment",
    "follow_up_needed",
    "recruiter_inbound",
  ];
  return m.kind !== null && human.includes(m.kind) ? "responded" : "applied";
}

function groupToRecord(g: Group, now: Date): FunnelRecord {
  const ms = g.messages;
  const first = ms[0];
  if (!first) throw new Error("empty group");
  const confirmation = ms.find((m) => m.kind === "confirmation");
  const stage = ms.map(stageOf).reduce(maxStage, "applied");
  const rejection = [...ms].reverse().find((m) => m.kind === "rejection");
  const last = ms.at(-1) ?? first;
  let outcome: FunnelOutcome = "open";
  let outcomeAt: Date | null = null;
  if (stage === "offer") {
    outcome = "offer";
    outcomeAt = ms.find((m) => stageOf(m) === "offer")?.receivedAt ?? null;
  } else if (rejection) {
    outcome = "rejected";
    outcomeAt = rejection.receivedAt;
  } else if (now.getTime() - last.receivedAt.getTime() > GHOST_AFTER_DAYS * DAY_MS) {
    outcome = "ghosted";
  }
  return {
    company: first.company ?? "",
    role: ms.find((m) => m.role !== null)?.role ?? null,
    appliedAt: (confirmation ?? first).receivedAt,
    stage,
    outcome,
    outcomeAt,
    // Gmail can't tell a cold apply from a referral; a recruiter's first message can.
    channel: first.kind === "recruiter_inbound" ? "recruiter_inbound" : null,
    source: "gmail",
  };
}

// Groups the classified messages (oldest first) into Gmail records. An ambiguous message here
// joins the newest candidate: the backfill already sent truly ambiguous ones to review, so this
// only happens for Paul's own placements, which name a company and role.
export function gmailRecords(messages: readonly FunnelMessageRow[], now: Date): FunnelRecord[] {
  const groups: Group[] = [];
  const classified = messages
    .filter((m) => m.status === "classified" && m.company !== null)
    .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
  for (const m of classified) {
    const p = placeMessage(groups, m);
    if (p.kind === "existing") groups[p.index]?.messages.push(m);
    else if (p.kind === "new") groups.push({ messages: [m] });
    else {
      const candidates = groups.filter((g) =>
        g.messages.some((x) => nameKey(x.company) === nameKey(m.company)),
      );
      candidates.at(-1)?.messages.push(m);
    }
  }
  return groups.map((g) => groupToRecord(g, now));
}

const dayToDate = (day: string) => new Date(`${day}T00:00:00Z`);

export type MergeConflict = {
  company: string;
  role: string | null;
  trackerOutcome: FunnelOutcome;
  gmailOutcome: FunnelOutcome;
};

// Merges Paul's tracker rows into the Gmail records (DX-002): same company, same role (or a Gmail
// record with no role) and applied within MERGE_WINDOW_DAYS. A merged record keeps the furthest
// stage. His tracker wins on outcome and channel; a disagreeing outcome is listed as a conflict.
export function mergeRecords(
  gmail: readonly FunnelRecord[],
  manual: readonly ManualRowInput[],
): { records: FunnelRecord[]; conflicts: MergeConflict[] } {
  const used = new Set<number>();
  const conflicts: MergeConflict[] = [];
  const records: FunnelRecord[] = [];
  for (const row of manual) {
    const applied = dayToDate(row.appliedOn);
    const i = gmail.findIndex(
      (g, idx) =>
        !used.has(idx) &&
        nameKey(g.company) === nameKey(row.company) &&
        (g.role === null || nameKey(g.role) === nameKey(row.role)) &&
        Math.abs(g.appliedAt.getTime() - applied.getTime()) <= MERGE_WINDOW_DAYS * DAY_MS,
    );
    const fromRow: FunnelRecord = {
      company: row.company,
      role: row.role,
      appliedAt: applied,
      stage: row.stageReached,
      outcome: row.outcome,
      outcomeAt: row.outcomeOn ? dayToDate(row.outcomeOn) : null,
      channel: row.channel,
      source: "manual",
    };
    const g = gmail[i];
    if (!g) {
      records.push(fromRow);
      continue;
    }
    used.add(i);
    if (g.outcome !== row.outcome) {
      conflicts.push({
        company: row.company,
        role: row.role,
        trackerOutcome: row.outcome,
        gmailOutcome: g.outcome,
      });
    }
    records.push({
      ...fromRow,
      // Gmail's timestamps are exact; the tracker has days only.
      appliedAt: g.appliedAt,
      outcomeAt: row.outcome === g.outcome ? (g.outcomeAt ?? fromRow.outcomeAt) : fromRow.outcomeAt,
      stage: maxStage(g.stage, row.stageReached),
      source: "both",
    });
  }
  gmail.forEach((g, i) => {
    if (!used.has(i)) records.push(g);
  });
  records.sort((a, b) => a.appliedAt.getTime() - b.appliedAt.getTime());
  return { records, conflicts };
}
