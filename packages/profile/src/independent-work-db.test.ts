import {
  type Db,
  independentWorkSchema,
  readIndependentWork,
  schema,
  setIndependentWork,
} from "@northstar/db";
import { createTestDb, sqlState } from "@northstar/db/testing";
import { CandidateId } from "@northstar/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { INVISIBLE_IN_WORK } from "./independent-work.js";

// NS-231 slice 5: the database refuses every character the parser refuses (migration 0092), so the
// two lists can't drift apart unnoticed. Synthetic entries only.

const CHECK_VIOLATION = "23514";

// Every code point the parser's pattern matches (surrogates aren't characters on their own).
const refused: string[] = [];
for (let c = 0; c <= 0x10ffff; c++) {
  if (c >= 0xd800 && c <= 0xdfff) continue;
  const ch = String.fromCodePoint(c);
  if (INVISIBLE_IN_WORK.test(ch)) refused.push(ch);
}

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let entryId: string;

// One database per file (NS-287): opening a PGlite copy per test passed Vitest's hook limit under
// CI's parallel load. Each test makes its own candidate and entry, and reads only those rows.
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});

beforeEach(async () => {
  const [c] = await db
    .insert(schema.candidate)
    .values({ displayName: "Test Candidate" })
    .returning();
  if (!c) throw new Error("no candidate");
  candidateId = CandidateId.parse(c.id);
  await setIndependentWork(db, {
    candidateId,
    entries: [
      {
        title: "Open-source rate limiter",
        start: "2025-01",
        end: null,
        link: "https://example.com/limiter",
        lines: ["Wrote a token-bucket limiter in Go."],
      },
    ],
  });
  const [entry] = (await db.select().from(independentWorkSchema.independentWorkEntry)).filter(
    (e) => e.candidateId === candidateId,
  );
  if (!entry) throw new Error("no entry");
  entryId = entry.id;
}, 30_000);

afterAll(async () => {
  await close();
});

// One insert of a line holding the given text, at a free position of the stored entry.
const insertLine = (text: string) =>
  db
    .insert(independentWorkSchema.independentWorkLine)
    .values({ candidateId, entryId, position: 1, text });

describe("the database's check on invisible characters in independent work", () => {
  it("covers a few hundred characters, so the parity test below means something", () => {
    expect(refused.length).toBeGreaterThan(400);
  });

  it("refuses a line holding any character the parser refuses", async () => {
    const leaked: string[] = [];
    for (const ch of refused) {
      if ((await sqlState(insertLine(`a${ch}b`))) !== CHECK_VIOLATION) {
        leaked.push(ch.codePointAt(0)?.toString(16) ?? "?");
      }
    }
    expect(leaked).toEqual([]);
  }, 60_000);

  it("refuses a title holding a right-to-left override, and a link holding a zero-width space", async () => {
    const [set] = (await db.select().from(independentWorkSchema.independentWorkSet)).filter(
      (s) => s.candidateId === candidateId,
    );
    if (!set) throw new Error("no set");
    const insertEntry = (title: string, link: string | null) =>
      db.insert(independentWorkSchema.independentWorkEntry).values({
        candidateId,
        setId: set.id,
        position: 1,
        title,
        startedOn: "2025-02",
        link,
      });
    expect([
      await sqlState(insertEntry(`Ledger${String.fromCodePoint(0x202e)}tool`, null)),
      await sqlState(
        insertEntry("Ledger tool", `https://example.com/a${String.fromCodePoint(0x200b)}b`),
      ),
    ]).toEqual([CHECK_VIOLATION, CHECK_VIOLATION]);
  });

  it("still stores ordinary text: accents, CJK, emoji and punctuation", async () => {
    const lines = ["Réécrit le cache en Go — 30 % plus rapide.", "数据管道 🚀 (v2)"];
    await setIndependentWork(db, {
      candidateId,
      entries: [
        {
          title: "Café ledger",
          start: "2025-03",
          end: null,
          link: "https://example.com/caf%C3%A9",
          lines,
        },
      ],
    });
    expect((await readIndependentWork(db, candidateId))?.entries[0]?.lines).toEqual(lines);
  });
});
