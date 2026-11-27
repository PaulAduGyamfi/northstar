import { describe, expect, it } from "vitest";
import { requestAllowed } from "./drafts.js";

const DRAFTS = "https://gmail.googleapis.com/gmail/v1/users/me/drafts";
const THREAD = "https://gmail.googleapis.com/gmail/v1/users/me/threads/18c2f0a1b2c3d4e5";
const QUERY = "?format=metadata&metadataHeaders=X-Northstar-Approval";
const draftBody = JSON.stringify({ message: { raw: "abc", threadId: "18c2f0a1b2c3d4e5" } });

describe("the draft writer's request allowlist (ADR-0025 item 4)", () => {
  it("allows creating a draft and reading one thread's marker headers", () => {
    expect(requestAllowed("POST", DRAFTS, draftBody)).toBe(true);
    expect(requestAllowed("GET", `${THREAD}${QUERY}`, undefined)).toBe(true);
  });

  it.each([
    ["sending a draft", "POST", `${DRAFTS}/send`, draftBody],
    [
      "sending a message",
      "POST",
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      draftBody,
    ],
    ["updating a draft", "PUT", `${DRAFTS}/r-123`, draftBody],
    ["deleting a draft", "DELETE", `${DRAFTS}/r-123`, undefined],
    ["listing drafts", "GET", DRAFTS, undefined],
    [
      "a draft body with another key",
      "POST",
      DRAFTS,
      JSON.stringify({ message: { raw: "a", threadId: "b" }, id: "r-1" }),
    ],
    [
      "a message with another key",
      "POST",
      DRAFTS,
      JSON.stringify({ message: { raw: "a", threadId: "b", labelIds: ["SENT"] } }),
    ],
    ["a body that isn't JSON", "POST", DRAFTS, "raw=abc"],
    ["a thread read with another query", "GET", `${THREAD}?format=full`, undefined],
    [
      "a thread read of a non-hex id",
      "GET",
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/abc..x${QUERY}`,
      undefined,
    ],
    [
      "a lookalike host",
      "POST",
      "https://gmail.googleapis.com.example.com/gmail/v1/users/me/drafts",
      draftBody,
    ],
    ["a thread read with a body", "GET", `${THREAD}${QUERY}`, "{}"],
  ])("refuses %s", (_what, method, url, body) => {
    expect(requestAllowed(method, url, body)).toBe(false);
  });
});
