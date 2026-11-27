import { describe, expect, it } from "vitest";
import { decidedMessage, decideProblem, LinkTargetsBody, threadRows } from "./inbox";

// The confirm queue's link and dismiss words (NS-262). Synthetic ids only.

describe("decidedMessage", () => {
  it("says what a link or dismiss did, and that a repeat decided nothing", () => {
    expect([
      decidedMessage("link", 2),
      decidedMessage("dismiss", 1),
      decidedMessage("link", 0),
    ]).toEqual([
      "Linked 2 emails to the application. It stays as it is: linking never changes a status.",
      "Dismissed 1 email. They leave the queue.",
      "Already decided: nothing in that thread was waiting.",
    ]);
  });
});

describe("decideProblem", () => {
  it("words each refusal, and anything else as a plain retry", () => {
    expect(
      ["not_found", "unknown_application", "application_closed", "unavailable", "odd"].map(
        decideProblem,
      ),
    ).toEqual([
      "That thread isn't waiting anymore. The list is reloaded.",
      "That application isn't one of yours anymore.",
      "That application is closed (rejected or withdrawn): pick another.",
      "Northstar couldn't save that right now. Try again.",
      "That didn't go through. Try again.",
    ]);
  });
});

describe("a thread Paul linked", () => {
  it("reads 'Linked by you'", () => {
    const [row] = threadRows(
      {
        applicationId: "0b6f3f8e-6a55-4c7e-9a52-5d6b2f8a1c01",
        jobTitle: null,
        company: null,
        status: "submitted",
        startedBy: null,
        submittedVia: null,
        threads: [
          {
            gmailThreadId: "aa01",
            gmailUrl: "https://mail.google.com/mail/u/0/#all/aa01",
            messages: 1,
            lastReceivedAt: "2026-11-25T12:00:00Z",
            step: "paul",
            senderVerified: false,
            kind: null,
          },
        ],
      },
      Date.parse("2026-11-25T14:00:00Z"),
    );
    expect(row?.linked).toBe("Linked by you");
  });
});

describe("LinkTargetsBody", () => {
  it("refuses a target whose id isn't a uuid", () => {
    expect(
      LinkTargetsBody.safeParse({
        items: [{ applicationId: "../evil", jobTitle: null, company: null }],
      }).success,
    ).toBe(false);
  });
});
