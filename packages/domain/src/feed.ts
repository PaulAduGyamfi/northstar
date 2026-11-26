// Feed lines (OBS-002): one plain sentence per domain event, for the activity feed. Pure code.
// A line uses only named payload fields of known event types, each checked for shape first, so
// a payload written wrong (or by a future writer) can't break the feed or put free text on
// screen. Ids are never shown. Events whose writers already give a full sentence as `reason`
// (stories, answers, the funnel) need no template; any type without one shows its reason.

export type FeedEvent = {
  type: string;
  actor: string;
  reason: string;
  payload: Record<string, unknown>;
};

type Payload = Record<string, unknown>;

// A name from a fixed vocabulary (dependency, subsystem, ATS, status, band, table): lowercase
// words joined by `_ . : -`. Anything else is treated as missing.
const NAME = /^[a-z0-9]+([_.:-][a-z0-9]+)*$/;
// An error name as breakers store it (TimeoutError, RateLimited).
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function name(p: Payload, key: string): string | undefined {
  const v = p[key];
  return typeof v === "string" && v.length <= 64 && NAME.test(v) ? v : undefined;
}

function count(p: Payload, key: string): number | undefined {
  const v = p[key];
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
}

// A tenant or ATS name as a verification window stores it ("Acme", "Workday"): letters, digits,
// spaces and a few marks, never markup (the same CHECK as verification_window in packages/db).
const LABEL = /^[A-Za-z0-9][A-Za-z0-9 .&'-]{0,63}$/;

function label(p: Payload, key: string): string | undefined {
  const v = p[key];
  return typeof v === "string" && LABEL.test(v) ? v : undefined;
}

// "Acme (Workday)", or "an employer account" when the names are missing or malformed.
function tenantAts(p: Payload): string {
  const tenant = label(p, "tenant");
  if (!tenant) return "an employer account";
  const ats = label(p, "ats");
  return ats ? `${tenant} (${ats})` : tenant;
}

const words = (s: string) => s.replaceAll("_", " ");
const capitalize = (s: string) => (s === "" ? s : s[0]?.toUpperCase() + s.slice(1));
const who = (actor: string) => (actor === "user" ? "You" : "Northstar");
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// "a Greenhouse board", "an Ashby board", or "a board" when the ATS is unknown.
const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");

function board(p: Payload): string {
  const ats = name(p, "ats");
  if (!ats) return "a board";
  return `${article(ats)} ${capitalize(ats)} board`;
}

// "a Greenhouse form", or "a form" when the ATS is unknown (human handoffs, NS-121).
function form(p: Payload): string {
  const ats = name(p, "ats");
  if (!ats) return "a form";
  return `${article(ats)} ${capitalize(ats)} form`;
}

// The challenge a handoff stopped at, in plain words (NEEDS_HUMAN_REASONS' challenge codes).
const CHALLENGE_WORDS: Record<string, string> = {
  captcha: "a CAPTCHA",
  login: "a sign-in",
  mfa: "a verification code",
  account: "an account sign-up",
};

// Why an application stopped for Paul, in plain words (NEEDS_HUMAN_REASONS, NS-120).
const STOP_WORDS: Record<string, string> = {
  ...CHALLENGE_WORDS,
  unmapped_required: "a required question it can't answer",
  form_changed: "a form that no longer matches the package",
  no_confirmation: "no confirmation page after submitting",
  driver_error: "a browser error, so it may or may not have gone out",
  outcome_unknown: "an earlier attempt that never finished",
  status_conflict: "an application that wasn't waiting for approval",
};

type Template = (p: Payload, e: FeedEvent) => string;

const TEMPLATES: Record<string, Template> = {
  "breaker.opened": (p) => {
    const dep = name(p, "dependency") ?? "a dependency";
    const n = count(p, "consecutiveFailures");
    const after = n === undefined ? "repeated failures" : `${n} failed calls`;
    const e = p.lastError;
    const error = typeof e === "string" && ERROR_NAME.test(e) ? ` (${e})` : "";
    return `Paused ${dep} after ${after}${error}`;
  },
  // The vault (NS-122): the tenant key and purpose code only, never anything secret.
  "vault_secret.stored": (p) => {
    const tenant = name(p, "tenant") ?? "an employer account";
    const v = count(p, "version");
    return `${v !== undefined && v > 1 ? "Changed" : "Saved"} the password for ${tenant}`;
  },
  "vault.opened": (p) => {
    const tenant = name(p, "tenant") ?? "an employer account";
    const purpose = name(p, "purpose");
    return `Used the saved password for ${tenant}${purpose ? ` to ${words(purpose)}` : ""}`;
  },
  // Verification windows (NS-151, VER-005): the tenant and ATS only, never a code or link.
  "verification.verified": (p) => `Verified email for ${tenantAts(p)}`,
  "verification.resend": (p) => `Sent the email code again for ${tenantAts(p)}`,
  "verification.needs_human": (p) => `Couldn't verify email for ${tenantAts(p)}: needs your hands`,
  // Mail links (NS-158): the step or reason only, never an address, subject or sender.
  "mail.linked": (p) => {
    const by: Record<string, string> = {
      tag: "its tagged address",
      thread: "its thread",
      sender: "its verified sender",
    };
    const step = name(p, "step");
    const how = step && by[step] ? ` by ${by[step]}` : "";
    // A tag or thread link from an unauthenticated sender says so (INB-011).
    const unverified =
      p.senderVerified === false && step !== "sender" ? " (sender not verified)" : "";
    return `Linked an email to its application${how}${unverified}`;
  },
  "mail.link_queued": (p) => {
    const reason = name(p, "reason");
    if (reason === "unknown_tag")
      return "An email to an unknown tagged address needs you to link it";
    if (reason === "ambiguous")
      return "An email could belong to more than one application: link it";
    return "An email couldn't be linked to an application: link it";
  },
  "handoff.opened": (p) => {
    const reason = name(p, "reason");
    const challenge = (reason && CHALLENGE_WORDS[reason]) ?? "a check";
    return `Needs your hands: ${form(p)} stopped at ${challenge}`;
  },
  "handoff.resolved": (p, e) => {
    const outcome = name(p, "outcome");
    if (outcome === "submitted") return `${who(e.actor)} finished an application by hand`;
    if (outcome === "gave_up") return `${who(e.actor)} set an application aside after a challenge`;
    return `${who(e.actor)} closed a handoff`;
  },
  // Employer accounts and consent (NS-124): the tenant key, statuses, reason code and notice
  // kind only, never the account email, a URL or a notice's text.
  "tenant.registered": (p) =>
    `Added ${name(p, "tenantKey") ?? "an employer"} to your employer accounts`,
  "tenant.account_changed": (p) => {
    const tenant = name(p, "tenantKey") ?? "an employer";
    const from = name(p, "from");
    const to = name(p, "to");
    const reason = name(p, "reason");
    if (!from || !to) return `Account on ${tenant} changed`;
    return `Account on ${tenant}: ${words(from)} to ${words(to)}${reason ? ` (${words(reason)})` : ""}`;
  },
  "consent.recorded": (p) => {
    const notice: Record<string, string> = {
      terms: "the candidate terms",
      privacy: "the privacy notice",
    };
    const kind = name(p, "kind");
    const what = (kind && notice[kind]) ?? "a notice";
    return `Accepted ${what} on ${name(p, "tenantKey") ?? "an employer"}`;
  },
  "consent.policy_set": (p, e) => {
    const policy = name(p, "policy");
    if (policy === "auto") {
      return `${who(e.actor)} set notices to be accepted automatically (marketing always declined)`;
    }
    if (policy === "ask_per_tenant") {
      return `${who(e.actor)} set notices to be asked about per employer`;
    }
    return `${who(e.actor)} changed the consent policy`;
  },
  "breaker.probing": (p) =>
    `Trying ${name(p, "dependency") ?? "a dependency"} again with one test call`,
  "breaker.closed": (p) => `${name(p, "dependency") ?? "A dependency"} is working again`,
  "kill_switch.set": (p, e) => {
    const on = p.enabled === true ? "on" : p.enabled === false ? "off" : undefined;
    const subsystem = name(p, "subsystem") ?? "a subsystem";
    return on
      ? `${who(e.actor)} switched ${on} ${subsystem}`
      : `${who(e.actor)} changed ${subsystem}`;
  },

  "source.watched": (p, e) => {
    const tier = count(p, "tier");
    return `${who(e.actor)} started watching ${board(p)}${tier ? ` (tier ${tier})` : ""}`;
  },
  "source.polled": (p) => {
    if (name(p, "outcome") === "failed") return `Couldn't read ${board(p)}`;
    const added = count(p, "added");
    const seen = count(p, "seen");
    if (added === undefined || seen === undefined) return capitalize(`read ${board(p)}`);
    return `Read ${board(p)}: ${added} new of ${plural(seen, "posting", "postings")}`;
  },
  "source.quarantined": (p) => {
    const n = count(p, "failures");
    return `Quarantined ${board(p)}${n === undefined ? "" : ` after ${n} failed reads`}`;
  },
  "source.retried": (p, e) => `${who(e.actor)} put ${board(p)} back`,
  "source.unwatched": (p, e) => `${who(e.actor)} stopped watching ${board(p)}`,

  "job.ingested": (p) => {
    const ats = name(p, "ats");
    const from = ats ? `${article(ats)} ${capitalize(ats)} posting` : "a link";
    const draft = p.draft === true ? " as a draft: some fields are missing" : "";
    return `Added a job from ${from}${draft}`;
  },
  "job.merged": (p) => {
    const n = count(p, "sources");
    return `Found the same job again${n === undefined ? "" : ` (${n} sources now)`}`;
  },
  "job.draft_completed": (p, e) => {
    const field = name(p, "field");
    return `${who(e.actor)} completed a draft job${field ? ` (${words(field)})` : ""}`;
  },
  "job.scored": (p) => {
    const score = count(p, "score");
    const band = name(p, "band");
    if (score === undefined) return "Scored a job";
    return `Scored a job ${score}${band ? ` (${words(band)})` : ""}`;
  },
  "preferences.changed": (p, e) => {
    const v = count(p, "toVersion");
    return `${who(e.actor)} changed your search preferences${v ? ` (version ${v})` : ""}`;
  },
  "preferences.rescored": (p) => {
    const jobs = count(p, "jobs");
    const v = count(p, "version");
    const what = jobs === undefined ? "jobs" : plural(jobs, "job", "jobs");
    return `Re-scored ${what}${v ? ` for preferences version ${v}` : ""}`;
  },

  "application.*": (p) => {
    const from = name(p, "from");
    const to = name(p, "to");
    // A fixed reason code (NS-218), never free text from the payload.
    if (to === "withdrawn" && p.reasonCode === "posting_closed") {
      return "Application withdrawn: the job's posting closed";
    }
    if (from && to) return `Application moved from ${words(from)} to ${words(to)}`;
    return to ? `Application is now ${words(to)}` : "Application status changed";
  },
  "approval.requested": (p) => {
    const kind = name(p, "kind");
    return kind ? `Waiting for your approval: ${words(kind)}` : "Waiting for your approval";
  },
  "approval.decided": (p) => {
    const decision = name(p, "decision");
    if (p.decidedBy === "policy" && decision === "approved") {
      return "Auto-approved by one of your rules";
    }
    return decision ? `You ${decision} a request` : "A request was decided";
  },
  "approval.undone": () => "You undid a decision; it is waiting again",
  // NS-140: Paul took a request back, or a gateway closed an approval whose content changed.
  // NS-239: the system closed a request whose job's posting closed.
  "approval.withdrawn": (p) => {
    const by = name(p, "withdrawnBy");
    if (by === "gateway") {
      return "An approval was withdrawn because its content changed; it can be asked for again";
    }
    if (by === "system") return "An approval request was closed because the job's posting closed";
    return "You withdrew a request; it can be asked for again";
  },
  // The Apply Gateway (NS-120): the ATS and the reason code only, never a field value or URL.
  "apply_submission.claimed": (p) => `Submitting an application through ${form(p)}`,
  "apply_submission.submitted": (p) => `Submitted an application through ${form(p)}`,
  "apply_submission.needs_human": (p) => {
    const reason = name(p, "reason");
    // Own keys only: "constructor" or "toString" must not reach Object's prototype.
    const why =
      reason !== undefined && Object.hasOwn(STOP_WORDS, reason)
        ? STOP_WORDS[reason]
        : "a check it can't pass";
    return `An application through ${form(p)} stopped at ${why}`;
  },
  "approval.policies_set": (p, e) => {
    const rules = count(p, "rules");
    const v = count(p, "version");
    const what =
      rules === undefined
        ? "auto-approve rules"
        : plural(rules, "auto-approve rule", "auto-approve rules");
    return `${who(e.actor)} set ${what}${v ? ` (version ${v})` : ""}`;
  },

  // A LinkedIn export (NS-133) or the personal site (NS-209) says so; a resume event carries no
  // kind.
  "profile.imported": (p) => {
    const kind = name(p, "kind");
    if (kind === "linkedin") return "Imported your LinkedIn export into the profile graph";
    if (kind === "site") return "Imported your personal site into the profile graph";
    return "Imported your resume into the profile graph";
  },
  "profile.locked_fact_edited": (p, e) => {
    const table = name(p, "table");
    return `${who(e.actor)} edited a locked fact${table ? ` (${words(table)})` : ""}`;
  },
  "profile.facts_set": (_p, e) => `${who(e.actor)} set your official employment record`,
  "profile.facts_checked": (p) => {
    const n = count(p, "mismatches");
    const result =
      n === undefined ? "" : `: ${n === 0 ? "no mismatches" : plural(n, "mismatch", "mismatches")}`;
    return `Checked your resume against your employment record${result}`;
  },
};

// The event types with a template ("application.*" covers every status move).
export const FEED_TYPES: readonly string[] = Object.keys(TEMPLATES);

export function feedLine(event: FeedEvent): string {
  const template =
    TEMPLATES[event.type] ??
    (event.type.startsWith("application.") ? TEMPLATES["application.*"] : undefined);
  const payload = event.payload !== null && typeof event.payload === "object" ? event.payload : {};
  if (template) return template(payload, event);
  const reason = event.reason.trim();
  if (reason !== "") return reason;
  // `widget.spun_up` → "Widget spun up".
  return capitalize(words(event.type.replace(".", " ")));
}
