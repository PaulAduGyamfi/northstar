import { CandidateId } from "@northstar/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { type JobFormQuestion, jobForm } from "./job-form-schema.js";
import { readJobAtsSources, readJobForm, saveJobForm } from "./job-form-write.js";
import { domainEvent, jobSource } from "./schema.js";
import { createTestDb, seedApplication, sqlState } from "./test/pglite.js";

// A job's application form (NS-227). Synthetic questions only.

const RESTRICT_VIOLATION = "23001";

let db: Db;
let close: () => Promise<void>;
let candidateId: CandidateId;
let jobId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const seeded = await seedApplication(db, "discovered");
  candidateId = CandidateId.parse(seeded.candidateId);
  jobId = seeded.jobId;
});

afterEach(async () => {
  await close();
});

const Q = (over: Partial<JobFormQuestion> = {}): JobFormQuestion => ({
  fieldName: "first_name",
  label: "First Name",
  required: true,
  kind: "text",
  choices: null,
  group: 0,
  ...over,
});
const FORM = [Q(), Q({ fieldName: "resume", label: "Resume/CV", kind: "file", group: 1 })];
const save = (questions: JobFormQuestion[], id = jobId) =>
  saveJobForm(db, { candidateId, jobId: id, ats: "greenhouse", questions });

describe("saveJobForm and readJobForm", () => {
  it("reads nothing before a form is stored", async () => {
    expect(await readJobForm(db, candidateId, jobId)).toBeNull();
  });

  it("stores a form once, however often the same one is read, with one event", async () => {
    const first = await save(FORM);
    const again = await save([...FORM]);
    const events = await db.select().from(domainEvent).where(eq(domainEvent.type, "job.form_read"));
    expect([
      first,
      again,
      (await readJobForm(db, candidateId, jobId))?.questions,
      events.map((e) => e.payload),
    ]).toEqual([
      { status: "stored", questions: 2 },
      { status: "unchanged", questions: 2 },
      FORM,
      [{ jobId, ats: "greenhouse", questions: 2 }],
    ]);
  });

  it("stores a changed form as a new version, and reads the newest", async () => {
    await save(FORM);
    const changed = [...FORM, Q({ fieldName: "phone", label: "Phone", required: false, group: 2 })];
    await save(changed);
    expect((await readJobForm(db, candidateId, jobId))?.questions).toEqual(changed);
  });

  it("refuses a form over its bounds, storing nothing", async () => {
    const tooMany = Array.from({ length: 201 }, (_, i) => Q({ fieldName: `f${i}`, group: i }));
    const longLabel = [Q({ label: "x".repeat(1001) })];
    const manyChoices = [
      Q({
        kind: "select",
        choices: Array.from({ length: 501 }, (_, i) => ({ label: `c${i}`, value: String(i) })),
      }),
    ];
    const results = [await save(tooMany), await save(longLabel), await save(manyChoices)];
    expect([results, (await db.select().from(jobForm)).length]).toEqual([
      [
        { status: "refused", reason: "too_many_fields" },
        { status: "refused", reason: "label_too_long" },
        { status: "refused", reason: "too_many_choices" },
      ],
      0,
    ]);
  });

  it("refuses changing, deleting or truncating a stored form", async () => {
    await save(FORM);
    expect([
      await sqlState(db.update(jobForm).set({ ats: "lever" })),
      await sqlState(db.delete(jobForm)),
      await sqlState(db.execute(sql`truncate job_form`)),
    ]).toEqual([RESTRICT_VIOLATION, RESTRICT_VIOLATION, RESTRICT_VIOLATION]);
  });
});

describe("readJobAtsSources", () => {
  it("lists a job's sources with their ATS, URL and posting id, the candidate's only", async () => {
    await db.insert(jobSource).values({
      candidateId,
      jobId,
      url: "https://boards.greenhouse.io/globex/jobs/4012345",
      method: "ats_api",
      ats: "greenhouse",
      atsPostingId: "4012345",
    });
    expect([
      await readJobAtsSources(db, candidateId, jobId),
      await readJobAtsSources(db, CandidateId.parse("00000000-0000-4000-8000-000000000009"), jobId),
    ]).toEqual([
      [
        {
          ats: "greenhouse",
          url: "https://boards.greenhouse.io/globex/jobs/4012345",
          atsPostingId: "4012345",
        },
      ],
      [],
    ]);
  });
});
