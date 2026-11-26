import { describe, expect, it } from "vitest";
import { type MailLink, mailStatusChange } from "./mail-status.js";

const verified: MailLink = { source: "match", senderVerified: true };
const unverified: MailLink = { source: "match", senderVerified: false };

describe("mailStatusChange", () => {
  it("applies a rejection from a verified sender on a deterministic link", () => {
    expect(mailStatusChange({ kind: "rejection", current: "submitted", link: verified })).toEqual({
      action: "apply",
      to: "rejected",
    });
  });

  it("proposes the same rejection when the sender isn't verified", () => {
    expect(mailStatusChange({ kind: "rejection", current: "submitted", link: unverified })).toEqual(
      { action: "propose", to: "rejected", reason: "sender_not_verified" },
    );
  });

  it("proposes a change when the link isn't deterministic, even from a verified sender", () => {
    const link: MailLink = { source: "other", senderVerified: true };
    expect(mailStatusChange({ kind: "offer", current: "in_process", link })).toEqual({
      action: "propose",
      to: "offer",
      reason: "link_not_deterministic",
    });
  });

  it("maps each kind that carries a status to its target", () => {
    const cases = [
      ["confirmation", "submitted", "confirmed"],
      ["assessment", "confirmed", "in_process"],
      ["interview_request", "submitted", "in_process"],
      ["scheduling", "confirmed", "in_process"],
      ["offer", "in_process", "offer"],
      ["rejection", "in_process", "rejected"],
    ] as const;
    for (const [kind, current, to] of cases) {
      expect(mailStatusChange({ kind, current, link: verified })).toEqual({ action: "apply", to });
    }
  });

  it("never changes a status for kinds that carry none", () => {
    for (const kind of ["recruiter_inbound", "follow_up_needed", "info_other"] as const) {
      expect(mailStatusChange({ kind, current: "submitted", link: verified })).toEqual({
        action: "none",
        reason: "no_status",
      });
    }
  });

  it("changes nothing when the application already has that status", () => {
    expect(mailStatusChange({ kind: "rejection", current: "rejected", link: verified })).toEqual({
      action: "none",
      reason: "same",
    });
  });

  it("never moves backwards: a confirmation after in_process changes nothing", () => {
    expect(
      mailStatusChange({ kind: "confirmation", current: "in_process", link: verified }),
    ).toEqual({ action: "none", reason: "not_a_move" });
  });

  it("never moves an application that hasn't been submitted", () => {
    expect(
      mailStatusChange({ kind: "rejection", current: "awaiting_approval", link: verified }),
    ).toEqual({ action: "none", reason: "not_a_move" });
  });

  it("revives a ghosted application on an interview request", () => {
    expect(
      mailStatusChange({ kind: "interview_request", current: "ghosted", link: verified }),
    ).toEqual({ action: "apply", to: "in_process" });
  });
});
