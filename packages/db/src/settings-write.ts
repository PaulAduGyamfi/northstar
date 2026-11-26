import { randomUUID } from "node:crypto";
import type { CandidateId } from "@northstar/domain";
import { asc, eq } from "drizzle-orm";
import type { Db } from "./db.js";
import {
  PROFILE_SETTING_FIELDS,
  profileSetting,
  QUALIFIED_SETTING_FIELDS,
} from "./profile-schema.js";
import { appendEvent, inSpan } from "./resilience-event.js";

// Paul's profile settings (NS-141, ANS-001): the only writer of profile_setting, plus the
// factual-answer use event. packages/profile types and checks each value before it gets here.
// Values and qualifiers are Paul's data: never in an event, span or error.

export type SettingField = (typeof PROFILE_SETTING_FIELDS)[number];
export type ProfileSettingView = { field: SettingField; qualifier: string; value: string };

const FIELDS = new Set<string>(PROFILE_SETTING_FIELDS);
const QUALIFIED = new Set<string>(QUALIFIED_SETTING_FIELDS);
export const isSettingField = (field: string): field is SettingField => FIELDS.has(field);
export const isQualifiedField = (field: string): boolean => QUALIFIED.has(field);

export type SettingRefusal = {
  kind: "InvalidSetting";
  reason: "unknown_field" | "qualifier_required" | "qualifier_not_allowed" | "bad_length";
};

// Qualifiers compare case-insensitively ("Go" and "go" are one skill).
const keyOf = (field: string, qualifier: string) => `${field}\u0000${qualifier.toLowerCase()}`;

// The shape the database CHECKs, checked here first so a bad input is a typed refusal, never a
// database error that would carry the value in its parameters.
function refusal(field: string, qualifier: string, value: string): SettingRefusal | null {
  if (!isSettingField(field)) return { kind: "InvalidSetting", reason: "unknown_field" };
  if (isQualifiedField(field) && qualifier.length === 0)
    return { kind: "InvalidSetting", reason: "qualifier_required" };
  if (!isQualifiedField(field) && qualifier.length > 0)
    return { kind: "InvalidSetting", reason: "qualifier_not_allowed" };
  if (qualifier.length > 100 || value.length < 1 || value.length > 300)
    return { kind: "InvalidSetting", reason: "bad_length" };
  return null;
}

// The current settings: the newest row per field and qualifier, sorted by field then qualifier.
export async function readProfileSettings(
  db: Pick<Db, "select">,
  candidateId: CandidateId,
): Promise<ProfileSettingView[]> {
  const rows = await db
    .select({
      field: profileSetting.field,
      qualifier: profileSetting.qualifier,
      value: profileSetting.value,
    })
    .from(profileSetting)
    .where(eq(profileSetting.candidateId, candidateId))
    .orderBy(asc(profileSetting.position));
  // Oldest first, so each later row replaces the one before it.
  const current = new Map<string, ProfileSettingView>();
  for (const r of rows)
    if (isSettingField(r.field))
      current.set(keyOf(r.field, r.qualifier), {
        field: r.field,
        qualifier: r.qualifier,
        value: r.value,
      });
  return [...current.values()].sort(
    (a, b) => a.field.localeCompare(b.field) || a.qualifier.localeCompare(b.qualifier),
  );
}

// Stores a new value for a field (and qualifier). The value it already has stores nothing.
export async function setProfileSetting(
  db: Db,
  input: { candidateId: CandidateId; field: string; qualifier?: string; value: string },
): Promise<{ ok: true; value: { saved: boolean } } | { ok: false; error: SettingRefusal }> {
  const qualifier = (input.qualifier ?? "").trim();
  const value = input.value.trim();
  const bad = refusal(input.field, qualifier, value);
  if (bad) return { ok: false, error: bad };
  const field = input.field;
  try {
    return await inSpan(
      "profile.setting_set",
      { "northstar.setting.field": field, "northstar.setting.qualified": qualifier.length > 0 },
      (span) =>
        db.transaction(async (tx) => {
          const current = (await readProfileSettings(tx, input.candidateId)).find(
            (s) => keyOf(s.field, s.qualifier) === keyOf(field, qualifier),
          );
          // Two identical saves racing may both store a row; the value is the same either way.
          if (current?.value === value) return { ok: true, value: { saved: false } } as const;
          const [row] = await tx
            .insert(profileSetting)
            .values({ candidateId: input.candidateId, field, qualifier, value })
            .returning({ id: profileSetting.id, createdAt: profileSetting.createdAt });
          if (!row) throw new Error("profile_setting insert returned no row");
          await appendEvent(tx, span, {
            candidateId: input.candidateId,
            aggregate: `profile_setting:${row.id}`,
            type: "profile.setting_set",
            actor: "user",
            // The field name is a fixed word; the value and qualifier never appear.
            reason: `You updated a profile setting (${field})`,
            payload: { settingId: row.id, field, qualified: qualifier.length > 0 },
            idempotencyKey: `profile_setting:${row.id}`,
            at: row.createdAt,
          });
          return { ok: true, value: { saved: true } } as const;
        }),
    );
  } catch {
    // A fresh error with no cause: the driver's message lists the query's parameters (the value).
    throw new Error("profile.setting_set failed");
  }
}

export type FactualUse = {
  candidateId: CandidateId;
  canonicalId: string;
  kind: "factual";
  field: SettingField;
  confidence: number;
};

// Records that a factual question was answered from a setting: ids, kind, field and confidence,
// never the form's question text or the setting's value.
export async function recordFactualAnswer(db: Db, use: FactualUse): Promise<void> {
  if (!/^[a-z0-9_.-]{1,64}$/.test(use.canonicalId) || !isSettingField(use.field))
    throw new Error("recordFactualAnswer: bad canonical id or field");
  const confidence = Math.round(Math.min(1, Math.max(0, use.confidence)) * 100) / 100;
  await inSpan("answer.factual_used", { "northstar.answer.field": use.field }, (span) =>
    db.transaction(async (tx) => {
      const id = randomUUID();
      await appendEvent(tx, span, {
        candidateId: use.candidateId,
        aggregate: `factual_answer:${id}`,
        type: "answer.factual_used",
        actor: "system",
        reason: `A factual question was answered from your ${use.field} setting, for your review`,
        payload: {
          canonicalId: use.canonicalId,
          kind: use.kind,
          field: use.field,
          confidence,
        },
        idempotencyKey: `factual_answer:${id}`,
        at: new Date(),
      });
    }),
  );
}
