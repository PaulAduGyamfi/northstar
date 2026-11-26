import {
  assignTag,
  type LinkDecision as DbLinkDecision,
  dbWindowStore,
  listConfirmQueue,
  readLinkCandidates,
  readLinkedThreads,
  readTags,
  recordMailLink,
} from "@northstar/db";
import { createTestDb, seedApplication } from "@northstar/db/testing";
import { CandidateId } from "@northstar/domain";
import { createGmailClient, GmailAccess, type MailPollDeps, pollNewMail } from "@northstar/inbox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The mail poller (NS-247) on the real write paths, on PGlite, with Gmail answered by a fake
// fetch: listing, headers and the profile. Synthetic mail only.

const SINCE = new Date("2026-11-25T12:00:00Z");

// One Gmail message as the metadata API returns it, received `minutes` after SINCE.
const gmailMessage = (id: string, minutes: number, deliveredTo: string, subject: string) => ({
  id,
  // A Gmail-shaped thread id (hex), one thread per message.
  threadId: `${id.slice(0, -2)}0${id.slice(-1)}`,
  internalDate: String(SINCE.getTime() + minutes * 60_000),
  labelIds: ["INBOX"],
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "Delivered-To", value: deliveredTo },
      { name: "From", value: "Globex Recruiting <talent@globex.example>" },
      { name: "Subject", value: subject },
    ],
  },
});

type Message = ReturnType<typeof gmailMessage>;

const fakeFetch = (messages: Message[], queries: string[]) =>
  (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/profile")) {
      return Response.json({ emailAddress: "candidate@example.com" });
    }
    if (url.pathname.endsWith("/messages")) {
      queries.push(url.searchParams.get("q") ?? "");
      // Newest first, as Gmail lists.
      const newest = [...messages].sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
      return Response.json({ messages: newest.map((m) => ({ id: m.id, threadId: m.threadId })) });
    }
    const id = url.pathname.split("/").at(-1);
    const m = messages.find((x) => x.id === id);
    return m ? Response.json(m) : new Response("{}", { status: 404 });
  }) as typeof fetch;

let test: Awaited<ReturnType<typeof createTestDb>>;
let candidateId: CandidateId;
let applicationId: string;

beforeEach(async () => {
  test = await createTestDb();
  const seeded = await seedApplication(test.db, "submitted");
  candidateId = CandidateId.parse(seeded.candidateId);
  applicationId = seeded.applicationId;
});

afterEach(async () => {
  await test.close();
});

describe("the mail poller on the database", () => {
  it("links tagged mail, queues untagged job mail, ignores the rest, and records nothing twice when run again", async () => {
    await assignTag(test.db, { candidateId, target: { applicationId }, newTag: () => "k3q2m7" });
    const queries: string[] = [];
    const gmail = createGmailClient({
      access: new GmailAccess("test-access-token"),
      fetch: fakeFetch(
        [
          gmailMessage("18c2a1f0e3b4d5a1", 1, "candidate+ns-k3q2m7@example.com", "Hello"),
          gmailMessage("18c2a1f0e3b4d5a2", 2, "candidate@example.com", "Thank you for applying"),
          gmailMessage("18c2a1f0e3b4d5a3", 3, "candidate@example.com", "Lunch on Friday?"),
        ],
        queries,
      ),
      sleep: async () => {},
      random: () => 0,
    });
    const store = dbWindowStore(test.db, candidateId);
    const deps: MailPollDeps = {
      gmail,
      knownDomains: new Set(),
      mailbox: await gmail.profileAddress(),
      openWindows: () => store.openWindows(),
      readTags: () => readTags(test.db, candidateId),
      readCandidates: () => readLinkCandidates(test.db, candidateId),
      readLinkedThreads: () => readLinkedThreads(test.db, candidateId),
      record: (input) =>
        recordMailLink(test.db, {
          candidateId,
          ...input,
          decision: input.decision as DbLinkDecision,
        }),
    };
    const first = await pollNewMail(deps, { since: SINCE });
    const again = await pollNewMail(deps, { since: first.nextSince });
    expect([first.linked, first.queued, first.notJobMail, first.stoppedBy]).toEqual([
      1,
      1,
      1,
      null,
    ]);
    expect([again.handled, again.stoppedBy]).toEqual([3, null]);
    // One link and one queued message, each recorded once across both runs.
    expect(await readLinkedThreads(test.db, candidateId)).toEqual(
      new Map([[applicationId, ["18c2a1f0e3b4d501"]]]),
    );
    expect((await listConfirmQueue(test.db, candidateId)).map((q) => q.gmailMessageId)).toEqual([
      "18c2a1f0e3b4d5a2",
    ]);
    expect(queries).toHaveLength(2);
  });
});
