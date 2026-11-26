import {
  assignTag,
  type LinkDecision as DbLinkDecision,
  dbWindowStore,
  listConfirmQueue,
  readLinkCandidates,
  readLinkedThreads,
  readTags,
  recordMailLink,
  schema,
} from "@northstar/db";
import { createTestDb, seedApplication } from "@northstar/db/testing";
import { CandidateId } from "@northstar/domain";
import {
  createGmailClient,
  GmailAccess,
  type LinkStepDeps,
  linkNewMessage,
} from "@northstar/inbox";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The mail-link step (#224) on the real write paths, on PGlite, with Gmail answered by a fake
// fetch. This package is the one that already depends on both inbox and db. Synthetic mail only.

const AT = new Date("2026-11-25T12:00:00Z");

// One Gmail message as the metadata API returns it.
const gmailMessage = (id: string, deliveredTo: string, labelIds: string[]) => ({
  id,
  threadId: "18c2a1f0e3b4d500",
  internalDate: String(AT.getTime()),
  labelIds,
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "Delivered-To", value: deliveredTo },
      { name: "From", value: "Globex Recruiting <talent@globex.example>" },
      { name: "Subject", value: "Next steps for your application" },
      {
        name: "Authentication-Results",
        value: "mx.google.com; dmarc=pass header.from=globex.example.com",
      },
    ],
  },
});

const fakeFetch = (messages: ReturnType<typeof gmailMessage>[]) =>
  (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/profile")) {
      return Response.json({ emailAddress: "candidate@example.com" });
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

const stepDeps = async (mailbox: string): Promise<LinkStepDeps> => {
  const store = dbWindowStore(test.db, candidateId);
  return {
    mailbox,
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
};

describe("the mail-link step on the database", () => {
  it("links tagged mail from Gmail to its application once, and skips Paul's sent copy", async () => {
    const { tag } = await assignTag(test.db, {
      candidateId,
      target: { applicationId },
      newTag: () => "k3q2m7",
    });
    const gmail = createGmailClient({
      access: new GmailAccess("ya29.test-access-token"),
      fetch: fakeFetch([
        gmailMessage("18c2a1f0e3b4d5a1", `candidate+ns-${tag}@example.com`, ["INBOX"]),
        gmailMessage("18c2a1f0e3b4d5a2", `candidate+ns-${tag}@example.com`, ["SENT"]),
      ]),
      sleep: async () => {},
      random: () => 0,
    });
    const deps = await stepDeps(await gmail.profileAddress());
    const received = await gmail.getHeaders("18c2a1f0e3b4d5a1");
    const results = [
      await linkNewMessage(deps, received),
      await linkNewMessage(deps, received),
      await linkNewMessage(deps, await gmail.getHeaders("18c2a1f0e3b4d5a2")),
    ];
    expect(results).toEqual([
      { kind: "linked", applicationId, step: "tag", recorded: true },
      { kind: "linked", applicationId, step: "tag", recorded: false },
      { kind: "skipped", reason: "unstamped" },
    ]);
    // One link, to the application's thread; nothing queued for Paul.
    expect(await readLinkedThreads(test.db, candidateId)).toEqual(
      new Map([[applicationId, ["18c2a1f0e3b4d500"]]]),
    );
    expect(await listConfirmQueue(test.db, candidateId)).toEqual([]);
  });

  it("queues mail for a withdrawn application's tag for Paul instead of linking it", async () => {
    await assignTag(test.db, { candidateId, target: { applicationId }, newTag: () => "k3q2m7" });
    await test.db
      .update(schema.application)
      .set({ status: "withdrawn" })
      .where(eq(schema.application.id, applicationId));
    const deps = await stepDeps("candidate@example.com");
    const gmail = createGmailClient({
      access: new GmailAccess("ya29.test-access-token"),
      fetch: fakeFetch([
        gmailMessage("18c2a1f0e3b4d5a1", "candidate+ns-k3q2m7@example.com", ["INBOX"]),
      ]),
      sleep: async () => {},
      random: () => 0,
    });
    expect(await linkNewMessage(deps, await gmail.getHeaders("18c2a1f0e3b4d5a1"))).toEqual({
      kind: "queued",
      reason: "unknown_tag",
      recorded: true,
    });
  });
});
