import { describe, expect, it } from "vitest";
import { replyNeed } from "./reply-need.js";

describe("replyNeed", () => {
  it("drafts a reply to a recruiter, an assessment invite and a follow-up request", () => {
    expect(["recruiter_inbound", "assessment", "follow_up_needed"].map(replyNeed)).toEqual([
      "reply",
      "reply",
      "reply",
    ]);
  });

  it("drafts interview and scheduling replies without times until Calendar exists", () => {
    expect(["interview_request", "scheduling"].map(replyNeed)).toEqual([
      "reply_without_times",
      "reply_without_times",
    ]);
  });

  it("drafts nothing for confirmations, rejections, offers and other mail", () => {
    expect(["confirmation", "rejection", "offer", "info_other"].map(replyNeed)).toEqual([
      "none",
      "none",
      "none",
      "none",
    ]);
  });

  it("drafts nothing for an unknown kind, including a prototype name", () => {
    expect(["thank_you", "constructor", ""].map(replyNeed)).toEqual(["none", "none", "none"]);
  });
});
