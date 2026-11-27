import { describe, expect, it } from "vitest";
import { FEED_TYPES, type FeedEvent, feedLine } from "./feed.js";

const ev = (type: string, payload: Record<string, unknown> = {}, over: Partial<FeedEvent> = {}) =>
  ({ type, actor: "system", reason: "", payload, ...over }) satisfies FeedEvent;

describe("feedLine: verification windows (NS-151)", () => {
  const p = { tenant: "Acme", ats: "Workday", purpose: "sign_up" };

  it("names the tenant and ATS for each outcome", () => {
    expect(feedLine(ev("verification.verified", p))).toBe("Verified email for Acme (Workday)");
    expect(feedLine(ev("verification.resend", p))).toBe(
      "Sent the email code again for Acme (Workday)",
    );
    expect(feedLine(ev("verification.needs_human", p))).toBe(
      "Couldn't verify email for Acme (Workday): needs your hands",
    );
  });

  it("never shows a tenant that isn't a plain name", () => {
    expect(feedLine(ev("verification.verified", { ...p, tenant: "<img src=x>" }))).toBe(
      "Verified email for an employer account",
    );
    expect(feedLine(ev("verification.verified", { ...p, ats: "482913 is your code: x" }))).toBe(
      "Verified email for Acme",
    );
  });
});

describe("feedLine: human handoffs (NS-121)", () => {
  it("says which kind of form needs Paul's hands, and why", () => {
    expect(feedLine(ev("handoff.opened", { ats: "greenhouse", reason: "captcha" }))).toBe(
      "Needs your hands: a Greenhouse form stopped at a CAPTCHA",
    );
    expect(feedLine(ev("handoff.opened", { ats: "ashby", reason: "login" }))).toBe(
      "Needs your hands: an Ashby form stopped at a sign-in",
    );
  });

  it("says what Paul did with a handoff", () => {
    expect(feedLine(ev("handoff.resolved", { outcome: "submitted" }, { actor: "user" }))).toBe(
      "You finished an application by hand",
    );
    expect(feedLine(ev("handoff.resolved", { outcome: "gave_up" }, { actor: "user" }))).toBe(
      "You set an application aside after a challenge",
    );
  });

  it("falls back to plain words for an unknown ATS or reason", () => {
    expect(feedLine(ev("handoff.opened", {}))).toBe("Needs your hands: a form stopped at a check");
  });
});

describe("feedLine: the Apply Gateway (NS-120, NS-160)", () => {
  it("says an application is being submitted and was submitted, through which ATS", () => {
    expect([
      feedLine(ev("apply_submission.claimed", { ats: "greenhouse" })),
      feedLine(ev("apply_submission.submitted", { ats: "ashby" })),
    ]).toEqual([
      "Submitting an application through a Greenhouse form",
      "Submitted an application through an Ashby form",
    ]);
  });

  it("says why an application stopped, in plain words", () => {
    expect([
      feedLine(ev("apply_submission.needs_human", { ats: "lever", reason: "captcha" })),
      feedLine(ev("apply_submission.needs_human", { ats: "lever", reason: "outcome_unknown" })),
    ]).toEqual([
      "An application through a Lever form stopped at a CAPTCHA",
      "An application through a Lever form stopped at an earlier attempt that never finished",
    ]);
  });

  it("falls back to plain words for an unknown ATS or reason", () => {
    expect(
      feedLine(ev("apply_submission.needs_human", { ats: "Not A Name", reason: "<b>x</b>" })),
    ).toBe("An application through a form stopped at a check it can't pass");
  });

  it("never reads a reason from Object's prototype", () => {
    expect(feedLine(ev("apply_submission.needs_human", { reason: "constructor" }))).toBe(
      "An application through a form stopped at a check it can't pass",
    );
  });
});

describe("feedLine: employer accounts and consent (NS-124)", () => {
  it("names the tenant and its ATS when one is registered", () => {
    expect(feedLine(ev("tenant.registered", { tenantKey: "workday:globex", ats: "workday" }))).toBe(
      "Added workday:globex to your employer accounts",
    );
  });

  it("says how an account's status changed, in words", () => {
    expect(
      feedLine(
        ev("tenant.account_changed", {
          tenantKey: "workday:globex",
          from: "none",
          to: "creating",
          reason: "started",
        }),
      ),
    ).toBe("Account on workday:globex: none to creating (started)");
    expect(
      feedLine(
        ev("tenant.account_changed", {
          tenantKey: "workday:globex",
          from: "creating",
          to: "needs_human",
          reason: "challenge",
        }),
      ),
    ).toBe("Account on workday:globex: creating to needs human (challenge)");
  });

  it("says which notice was accepted and where, never its text", () => {
    expect(feedLine(ev("consent.recorded", { tenantKey: "workday:globex", kind: "privacy" }))).toBe(
      "Accepted the privacy notice on workday:globex",
    );
    expect(feedLine(ev("consent.recorded", { tenantKey: "workday:globex", kind: "terms" }))).toBe(
      "Accepted the candidate terms on workday:globex",
    );
  });

  it("says which consent policy Paul chose", () => {
    expect(feedLine(ev("consent.policy_set", { policy: "auto" }, { actor: "user" }))).toBe(
      "You set notices to be accepted automatically (marketing always declined)",
    );
    expect(
      feedLine(ev("consent.policy_set", { policy: "ask_per_tenant" }, { actor: "user" })),
    ).toBe("You set notices to be asked about per employer");
  });
});

describe("feedLine: resilience", () => {
  it("says which dependency paused, after how many failures and why", () => {
    expect(
      feedLine(
        ev("breaker.opened", {
          dependency: "anthropic",
          consecutiveFailures: 5,
          lastError: "RateLimited",
        }),
      ),
    ).toBe("Paused anthropic after 5 failed calls (RateLimited)");
  });

  it("says a dependency is being tried again, and that it recovered", () => {
    expect(feedLine(ev("breaker.probing", { dependency: "gmail" }))).toBe(
      "Trying gmail again with one test call",
    );
    expect(feedLine(ev("breaker.closed", { dependency: "gmail" }))).toBe("gmail is working again");
  });

  it("says who switched a subsystem on or off", () => {
    expect(
      feedLine(
        ev("kill_switch.set", { subsystem: "auto_apply", enabled: false }, { actor: "user" }),
      ),
    ).toBe("You switched off auto_apply");
    expect(feedLine(ev("kill_switch.set", { subsystem: "source:lever", enabled: true }))).toBe(
      "Northstar switched on source:lever",
    );
  });
});

describe("feedLine: sourcing and scoring", () => {
  it("describes a polled board by its ATS and counts, never a board name", () => {
    expect(
      feedLine(ev("source.polled", { ats: "greenhouse", outcome: "ok", seen: 14, added: 2 })),
    ).toBe("Read a Greenhouse board: 2 new of 14 postings");
    expect(feedLine(ev("source.polled", { ats: "lever", outcome: "failed" }))).toBe(
      "Couldn't read a Lever board",
    );
  });

  it("describes watching, quarantine, retry and unwatching a board", () => {
    expect(feedLine(ev("source.watched", { ats: "ashby", tier: 1 }, { actor: "user" }))).toBe(
      "You started watching an Ashby board (tier 1)",
    );
    expect(feedLine(ev("source.quarantined", { ats: "workable", failures: 5 }))).toBe(
      "Quarantined a Workable board after 5 failed reads",
    );
    expect(feedLine(ev("source.retried", { ats: "lever" }, { actor: "user" }))).toBe(
      "You put a Lever board back",
    );
    expect(feedLine(ev("source.unwatched", { ats: "lever" }, { actor: "user" }))).toBe(
      "You stopped watching a Lever board",
    );
  });

  it("describes added, merged, completed and scored jobs", () => {
    expect(
      feedLine(ev("job.ingested", { method: "ats_api", ats: "greenhouse", draft: false })),
    ).toBe("Added a job from a Greenhouse posting");
    expect(feedLine(ev("job.ingested", { method: "ats_api", ats: "ashby" }))).toBe(
      "Added a job from an Ashby posting",
    );
    expect(feedLine(ev("job.ingested", { method: "text", draft: true }))).toBe(
      "Added a job from a link as a draft: some fields are missing",
    );
    expect(feedLine(ev("job.merged", { sources: 3 }))).toBe(
      "Found the same job again (3 sources now)",
    );
    expect(feedLine(ev("job.draft_completed", { field: "title" }, { actor: "user" }))).toBe(
      "You completed a draft job (title)",
    );
    expect(feedLine(ev("job.scored", { score: 91, band: "queue" }))).toBe(
      "Scored a job 91 (queue)",
    );
  });

  it("describes changed preferences and the re-scoring they caused", () => {
    expect(feedLine(ev("preferences.changed", { toVersion: 4 }, { actor: "user" }))).toBe(
      "You changed your search preferences (version 4)",
    );
    expect(feedLine(ev("preferences.rescored", { version: 4, jobs: 37 }))).toBe(
      "Re-scored 37 jobs for preferences version 4",
    );
  });
});

describe("feedLine: applications and approvals", () => {
  it("describes a status move in words", () => {
    expect(feedLine(ev("application.submitted", { from: "submitting", to: "submitted" }))).toBe(
      "Application moved from submitting to submitted",
    );
    expect(feedLine(ev("application.needs_human", { to: "needs_human" }))).toBe(
      "Application is now needs human",
    );
  });

  it("says an application left the pipeline because its posting closed (NS-218)", () => {
    expect(
      feedLine(
        ev("application.withdrawn", {
          from: "queued",
          to: "withdrawn",
          reasonCode: "posting_closed",
        }),
      ),
    ).toBe("Application withdrawn: the job's posting closed");
  });

  it("describes a withdrawal by Paul or by a gateway (NS-140)", () => {
    expect([
      feedLine(ev("approval.withdrawn", { withdrawnBy: "user" }, { actor: "user" })),
      feedLine(ev("approval.withdrawn", { withdrawnBy: "gateway" })),
    ]).toEqual([
      "You withdrew a request; it can be asked for again",
      "An approval was withdrawn because its content changed; it can be asked for again",
    ]);
  });

  it("says an edit withdrew a request and its edited version is waiting (NS-203)", () => {
    expect(
      feedLine(ev("approval.withdrawn", { withdrawnBy: "user", edited: true }, { actor: "user" })),
    ).toBe("You edited a request; the edited version is waiting for your approval");
  });

  it("says Paul asked to see a password for a reveal, never that it waits or which tenant", () => {
    expect(
      feedLine(
        ev("approval.requested", { kind: "vault_reveal", subject: "vault_reveal:workday-acme" }),
      ),
    ).toBe("You asked to see a saved password");
  });

  it("describes approval requests, decisions, undo and policies", () => {
    expect(feedLine(ev("approval.requested", { kind: "application_package" }))).toBe(
      "Waiting for your approval: application package",
    );
    expect(
      feedLine(
        ev("approval.decided", { decision: "approved", decidedBy: "user" }, { actor: "user" }),
      ),
    ).toBe("You approved a request");
    expect(feedLine(ev("approval.decided", { decision: "approved", decidedBy: "policy" }))).toBe(
      "Auto-approved by one of your rules",
    );
    expect(feedLine(ev("approval.decided", { decision: "rejected", decidedBy: "user" }))).toBe(
      "You rejected a request",
    );
    expect(feedLine(ev("approval.undone", {}, { actor: "user" }))).toBe(
      "You undid a decision; it is waiting again",
    );
    expect(feedLine(ev("approval.policies_set", { rules: 2, version: 3 }, { actor: "user" }))).toBe(
      "You set 2 auto-approve rules (version 3)",
    );
  });
});

describe("feedLine: profile", () => {
  it("names a LinkedIn export import (NS-133)", () => {
    expect(feedLine(ev("profile.imported", { kind: "linkedin" }))).toBe(
      "Imported your LinkedIn export into the profile graph",
    );
  });

  it("names a personal site import (NS-209)", () => {
    expect(feedLine(ev("profile.imported", { kind: "site" }))).toBe(
      "Imported your personal site into the profile graph",
    );
  });

  it("describes resume import, locked-fact edits and the employment-facts check", () => {
    expect(feedLine(ev("profile.imported"))).toBe("Imported your resume into the profile graph");
    expect(feedLine(ev("profile.locked_fact_edited", { table: "role" }, { actor: "user" }))).toBe(
      "You edited a locked fact (role)",
    );
    expect(feedLine(ev("profile.facts_set", {}, { actor: "user" }))).toBe(
      "You set your official employment record",
    );
    expect(feedLine(ev("profile.facts_checked", { mismatches: 0 }))).toBe(
      "Checked your resume against your employment record: no mismatches",
    );
    expect(feedLine(ev("profile.facts_checked", { mismatches: 1 }))).toBe(
      "Checked your resume against your employment record: 1 mismatch",
    );
  });
});

describe("feedLine: fallbacks and bad payloads", () => {
  it("uses the event's reason for a type without a template", () => {
    expect(
      feedLine(ev("story.approved", {}, { reason: "Paul approved a story for the story bank" })),
    ).toBe("Paul approved a story for the story bank");
  });

  it("uses the type in words when there is no reason either", () => {
    expect(feedLine(ev("widget.spun_up"))).toBe("Widget spun up");
  });

  it("leaves out payload values of the wrong shape instead of throwing or showing them", () => {
    expect(
      feedLine(
        ev("breaker.opened", {
          dependency: "<script>alert(1)</script>",
          consecutiveFailures: "five",
          lastError: "see https://evil.example",
        }),
      ),
    ).toBe("Paused a dependency after repeated failures");
    expect(feedLine(ev("source.polled", { ats: { nested: true }, outcome: "ok" }))).toBe(
      "Read a board",
    );
  });

  it("never throws, whatever the payload holds", () => {
    for (const type of FEED_TYPES) {
      for (const payload of [{}, { a: null }, { from: 1, to: [], dependency: 7, ats: "" }]) {
        expect(typeof feedLine(ev(type, payload))).toBe("string");
      }
    }
  });

  it("has a template for every event type whose reason alone doesn't say what happened", () => {
    // story.*, answer.* and funnel.* writers give a full sentence as their reason. A new event
    // type should get a template here; until it does, its reason is shown.
    expect([...FEED_TYPES].sort()).toEqual([
      "application.*",
      "apply_submission.claimed",
      "apply_submission.needs_human",
      "apply_submission.submitted",
      "approval.decided",
      "approval.policies_set",
      "approval.requested",
      "approval.undone",
      "approval.withdrawn",
      "breaker.closed",
      "breaker.opened",
      "breaker.probing",
      "consent.policy_set",
      "consent.recorded",
      "handoff.opened",
      "handoff.resolved",
      "job.draft_completed",
      "job.ingested",
      "job.merged",
      "job.scored",
      "kill_switch.set",
      "mail.link_queued",
      "mail.linked",
      "preferences.changed",
      "preferences.rescored",
      "profile.facts_checked",
      "profile.facts_set",
      "profile.imported",
      "profile.locked_fact_edited",
      "source.polled",
      "source.quarantined",
      "source.retried",
      "source.unwatched",
      "source.watched",
      "tenant.account_changed",
      "tenant.registered",
      "vault.opened",
      "vault_secret.stored",
      "verification.needs_human",
      "verification.resend",
      "verification.verified",
    ]);
  });
});

describe("feedLine: credential vault", () => {
  it("says a password was saved, and changed on a later version", () => {
    expect(feedLine(ev("vault_secret.stored", { tenant: "workday:acme", version: 1 }))).toBe(
      "Saved the password for workday:acme",
    );
    expect(feedLine(ev("vault_secret.stored", { tenant: "workday:acme", version: 2 }))).toBe(
      "Changed the password for workday:acme",
    );
  });

  it("says a saved password was used and what for", () => {
    expect(
      feedLine(ev("vault.opened", { tenant: "workday:acme", version: 1, purpose: "sign_in" })),
    ).toBe("Used the saved password for workday:acme to sign in");
  });
});

describe("feedLine: mail links", () => {
  it("says an email was linked and by which step", () => {
    expect([
      feedLine(ev("mail.linked", { step: "tag", senderVerified: true })),
      feedLine(ev("mail.linked", { step: "thread", senderVerified: false })),
      feedLine(ev("mail.linked", { step: "sender", senderVerified: true })),
    ]).toEqual([
      "Linked an email to its application by its tagged address",
      "Linked an email to its application by its thread (sender not verified)",
      "Linked an email to its application by its verified sender",
    ]);
  });

  it("says an email waits for Paul to link it, and why", () => {
    expect([
      feedLine(ev("mail.link_queued", { reason: "unknown_tag" })),
      feedLine(ev("mail.link_queued", { reason: "ambiguous" })),
      feedLine(ev("mail.link_queued", { reason: "no_match" })),
    ]).toEqual([
      "An email to an unknown tagged address needs you to link it",
      "An email could belong to more than one application: link it",
      "An email couldn't be linked to an application: link it",
    ]);
  });
});

describe("feedLine: a request closed for a closed posting (NS-239)", () => {
  it("says the system closed it because the job's posting closed", () => {
    expect(
      feedLine(ev("approval.withdrawn", { withdrawnBy: "system", reason: "posting_closed" })),
    ).toBe("An approval request was closed because the job's posting closed");
  });
});
