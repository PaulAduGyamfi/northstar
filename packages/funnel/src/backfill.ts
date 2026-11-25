import type { FunnelMessageInput, FunnelMessageRow, ReviewReason } from "@northstar/db";
import {
  BODY_LIMIT,
  backfillQuery,
  checkMailProvenance,
  classifyByRules,
  type GmailClient,
  isAuthenticatedSender,
  isJobMail,
  type MailClassification,
  type MailClassifyInput,
  type MessageHeaders,
} from "@northstar/inbox";
import type { LlmGateway, Route } from "@northstar/llm";
import { buildGroups, placeMessage } from "./records.js";

// The 9-month backfill (DX-001): list → pre-filter on headers → rules → mail-classify → store.
// Each message is stored as soon as it's decided, so a crash or an API outage loses nothing and a
// rerun resumes where it stopped (safe to repeat). Nothing from a body is stored.

// A rough per-call estimate for the up-front cost line (one short email at low effort). The real
// cost comes from the call records at the end.
export const ESTIMATED_USD_PER_CALL = 0.02;

export type BackfillStore = {
  knownIds: (gmailIds: string[]) => Promise<Set<string>>;
  save: (message: FunnelMessageInput) => Promise<void>;
  // Every job message stored so far (for known sender domains and for placing new messages).
  messages: () => Promise<FunnelMessageRow[]>;
};

export type BackfillDeps = {
  gmail: GmailClient;
  gateway: LlmGateway;
  route: Route<MailClassifyInput, MailClassification>;
  store: BackfillStore;
  print: (line: string) => void;
};

export type BackfillCounts = {
  listed: number;
  alreadyKnown: number;
  notJob: number;
  ruleClassified: number;
  modelClassified: number;
  review: number;
  // Job messages left for the next run because of --max-messages.
  deferred: number;
  modelCalls: number;
  // Messages fetched in full (job mail only) and found through a job thread's listing.
  fetched: number;
  fromThreads: number;
  // null when a call's model had no known price.
  costUsd: number | null;
};

export function emptyCounts(): BackfillCounts {
  return {
    listed: 0,
    alreadyKnown: 0,
    notJob: 0,
    ruleClassified: 0,
    modelClassified: 0,
    review: 0,
    deferred: 0,
    modelCalls: 0,
    fetched: 0,
    fromThreads: 0,
    costUsd: 0,
  };
}

// `counts` is filled in as the run goes, so a caller still has the progress if the run stops.
export async function runBackfill(
  deps: BackfillDeps,
  options: { since: string; maxMessages: number },
  counts: BackfillCounts = emptyCounts(),
): Promise<BackfillCounts> {
  const listed = await deps.gmail.listIds(backfillQuery(options.since));
  counts.listed = listed.length;
  const known = await deps.store.knownIds(listed.map((m) => m.id));
  counts.alreadyKnown = known.size;

  const stored = await deps.store.messages();
  const knownDomains = new Set(
    stored.flatMap((m) => (m.status === "classified" && m.senderDomain ? [m.senderDomain] : [])),
  );

  // Pass 1: headers only. A message is job mail by its sender or subject (INB-002), or because
  // it's in a thread that holds job mail. A search lists matching messages, not whole threads, so
  // each job thread is listed too: that's how a reply titled "Intro call" is found at all.
  const seen = new Set(known);
  const fresh: MessageHeaders[] = [];
  for (const { id } of listed) {
    if (seen.has(id)) continue;
    seen.add(id);
    fresh.push(await deps.gmail.getHeaders(id));
  }
  const jobThreads = new Set(stored.map((m) => m.threadId));
  for (const h of fresh) {
    if (readable(h) && isJobMail(h, knownDomains)) jobThreads.add(h.threadId);
  }
  const threadIds = [...jobThreads];
  for (const threadId of threadIds) {
    for (const { id } of await deps.gmail.threadMessageIds(threadId)) {
      if (seen.has(id)) continue;
      seen.add(id);
      fresh.push(await deps.gmail.getHeaders(id));
      counts.fromThreads += 1;
    }
  }
  const knownAfterThreads = await deps.store.knownIds(fresh.map((h) => h.id));
  const jobs: { headers: MessageHeaders; rule: ReturnType<typeof classifyByRules> }[] = [];
  for (const h of fresh) {
    // Stored by an earlier run (found again through its thread): nothing to do.
    if (knownAfterThreads.has(h.id)) continue;
    const job = jobThreads.has(h.threadId);
    if (!readable(h)) {
      // Gmail returned something unreadable (no sender, no date): Paul looks if it may be job
      // mail, nothing else does. It never reaches the model (DX-001 failure modes).
      const status = job ? "needs_review" : "not_job";
      await deps.store.save({
        ...base({ ...h, receivedAt: validDate(h.receivedAt) }, status, null),
        reviewReason: job ? "unparseable" : null,
      });
      if (job) counts.review += 1;
      else counts.notJob += 1;
      continue;
    }
    if (!job) {
      await deps.store.save(base(h, "not_job", null));
      counts.notJob += 1;
      continue;
    }
    // Rules only for a sender Gmail verified: a forged "Thank you for applying" goes to the model.
    jobs.push({ headers: h, rule: isAuthenticatedSender(h) ? classifyByRules(h) : null });
  }
  // Oldest first, so records grow in the order things happened.
  jobs.sort((a, b) => a.headers.receivedAt.getTime() - b.headers.receivedAt.getTime());

  const needModel = jobs.filter((j) => j.rule === null).length;
  const allowed = Math.min(needModel, options.maxMessages);
  counts.deferred = needModel - allowed;
  deps.print(
    `${jobs.length} job emails: ${jobs.length - needModel} by rules, ${allowed} for the model (about $${(allowed * ESTIMATED_USD_PER_CALL).toFixed(2)})${counts.deferred > 0 ? `, ${counts.deferred} left for the next run (--max-messages)` : ""}.`,
  );

  const placed: FunnelMessageRow[] = [...stored];
  let modelBudget = allowed;
  for (const { headers, rule } of jobs) {
    let input: FunnelMessageInput;
    if (rule) {
      input = {
        ...base(headers, "classified", "rules"),
        kind: rule.kind,
        company: rule.company,
        role: rule.role,
        stageSignal: "none",
      };
      counts.ruleClassified += 1;
    } else {
      // Left unstored, so the next run picks it up.
      if (modelBudget === 0) continue;
      modelBudget -= 1;
      input = await classifyWithModel(deps, headers, counts);
    }
    if (input.status === "classified") {
      // A message that fits two applications goes to Paul instead of a guess (DX-001).
      const p = placeMessage(buildGroups(placed), asRow(input));
      if (p.kind === "ambiguous") input = toReview(input, "ambiguous");
    }
    if (input.status === "needs_review") counts.review += 1;
    else if (input.status === "not_job") counts.notJob += 1;
    else if (input.classifiedBy === "model") counts.modelClassified += 1;
    await deps.store.save(input);
    if (input.status === "classified") {
      placed.push(asRow(input));
      // Only a verified sender's domain lets later mail through on the domain alone.
      if (input.senderDomain && isAuthenticatedSender(headers))
        knownDomains.add(input.senderDomain);
    }
  }
  return counts;
}

async function classifyWithModel(
  deps: BackfillDeps,
  headers: MessageHeaders,
  counts: BackfillCounts,
): Promise<FunnelMessageInput> {
  const full = await deps.gmail.getFull(headers.id);
  counts.fetched += 1;
  const outcome = await deps.gateway.call(deps.route, {
    from: full.from,
    subject: full.subject,
    date: full.receivedAt.toISOString().slice(0, 10),
    body: full.body,
  });
  counts.modelCalls += 1;
  const cost = outcome.record.costUsd;
  counts.costUsd = counts.costUsd === null || cost === null ? null : counts.costUsd + cost;
  const stamp = { promptVersion: outcome.record.promptVersion, model: outcome.record.modelServed };
  const review = (reason: ReviewReason) => ({
    ...base(headers, "needs_review", null),
    ...stamp,
    reviewReason: reason,
  });
  switch (outcome.kind) {
    case "Refused":
      return review("refused");
    case "Truncated":
      return review("truncated");
    case "InvalidOutput":
      return review("invalid_output");
    case "Ok": {
      const o = outcome.output;
      // The model says it isn't about one of Paul's applications: out of the funnel.
      if (o.kind === "info_other") return { ...base(headers, "not_job", null), ...stamp };
      // No employer named: Paul places it, or nothing does.
      if (o.company === null) return review("ambiguous");
      // Code decides: every name must be in the email itself (ADR-0004).
      // Checked against the text the model saw (the body is cut at BODY_LIMIT for it).
      const seenText = {
        from: full.from,
        subject: full.subject,
        body: full.body.slice(0, BODY_LIMIT),
      };
      if (checkMailProvenance(o, seenText).length > 0) return review("provenance");
      return {
        ...base(headers, "classified", "model"),
        ...stamp,
        kind: o.kind,
        company: o.company,
        role: o.role,
        requisition: o.requisition,
        stageSignal: o.stageSignal,
      };
    }
  }
}

function base(
  h: MessageHeaders,
  status: FunnelMessageInput["status"],
  classifiedBy: FunnelMessageInput["classifiedBy"],
): FunnelMessageInput {
  return {
    gmailId: h.id,
    threadId: h.threadId,
    // Personal mail keeps no sender domain (NFR-SEC-005).
    senderDomain: status === "not_job" ? null : h.senderDomain || null,
    receivedAt: h.receivedAt,
    status,
    kind: null,
    company: null,
    role: null,
    requisition: null,
    stageSignal: null,
    classifiedBy,
    reviewReason: null,
    promptVersion: null,
    model: null,
  };
}

function toReview(input: FunnelMessageInput, reason: ReviewReason): FunnelMessageInput {
  return { ...input, status: "needs_review", classifiedBy: null, reviewReason: reason };
}

// A stored-row view of an input, for placing it among the groups.
function asRow(input: FunnelMessageInput): FunnelMessageRow {
  return {
    ...input,
    id: input.gmailId,
    status: input.status === "classified" ? "classified" : "needs_review",
  };
}

// A message the pipeline can work with: a sender domain and a real date.
function readable(h: MessageHeaders): boolean {
  return h.senderDomain !== "" && !Number.isNaN(h.receivedAt.getTime());
}

// The database needs a date: an unreadable one becomes "now" (the review item shows it as found).
function validDate(d: Date): Date {
  return Number.isNaN(d.getTime()) ? new Date() : d;
}
