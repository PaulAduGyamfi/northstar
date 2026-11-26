import { type CandidateId, ContactDetails } from "@northstar/domain";
import { desc, eq } from "drizzle-orm";
import { profileContact } from "./contact-schema.js";
import type { Db } from "./db.js";
import { appendEvent, inSpan } from "./resilience-event.js";

// Paul's contact details (NS-227 slice 3, APPLY-001): the only writer and reader of
// profile_contact. Names, email and phone are Paul's data: never in an event, span or error.

export type ContactRefusal = {
  kind: "InvalidContact";
  // Which fields failed, by name only: never their values.
  fields: ("firstName" | "lastName" | "email" | "phone")[];
};

const MAX_EMAIL = 254;
// Control characters, line and paragraph separators, and invisible format characters (bidi
// overrides, zero-width spaces): none belongs on a form, and some may fail the database's
// [[:cntrl:]] CHECK under a UTF-8 locale, which would give Paul a bare error instead of the field.
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}\p{Cf}]/u;

// The package's own contact schema, plus what the database CHECKs (an email length and no control
// characters), so a bad input is a typed refusal, never a database error carrying the values.
function check(input: ContactDetails): ContactDetails | ContactRefusal {
  // Only the four fields: an extra key from a caller is ignored, never an empty refusal.
  const parsed = ContactDetails.safeParse({
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    phone: input.phone,
  });
  const fields = new Set<ContactRefusal["fields"][number]>();
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (field === "firstName" || field === "lastName" || field === "email" || field === "phone")
        fields.add(field);
    }
  }
  const value = parsed.success ? parsed.data : input;
  if (typeof value.email === "string" && value.email.length > MAX_EMAIL) fields.add("email");
  for (const field of ["firstName", "lastName", "email", "phone"] as const) {
    const text = value[field];
    if (typeof text === "string" && CONTROL.test(text)) fields.add(field);
  }
  if (fields.size > 0 || !parsed.success)
    return { kind: "InvalidContact", fields: [...fields].sort() };
  return parsed.data;
}

const same = (a: ContactDetails, b: ContactDetails) =>
  a.firstName === b.firstName &&
  a.lastName === b.lastName &&
  a.email === b.email &&
  a.phone === b.phone;

// Paul's current contact details, or null before he sets them.
export async function readContact(
  db: Pick<Db, "select">,
  candidateId: CandidateId,
): Promise<ContactDetails | null> {
  const [row] = await db
    .select({
      firstName: profileContact.firstName,
      lastName: profileContact.lastName,
      email: profileContact.email,
      phone: profileContact.phone,
    })
    .from(profileContact)
    .where(eq(profileContact.candidateId, candidateId))
    .orderBy(desc(profileContact.position))
    .limit(1);
  return row ?? null;
}

// Stores Paul's contact details as the current ones. What the current row already holds stores
// nothing.
export async function setContact(
  db: Db,
  input: { candidateId: CandidateId; contact: ContactDetails },
): Promise<{ ok: true; value: { saved: boolean } } | { ok: false; error: ContactRefusal }> {
  const checked = check(input.contact);
  if ("kind" in checked) return { ok: false, error: checked };
  const contact = checked;
  try {
    return await inSpan(
      "profile.contact_set",
      { "northstar.contact.phone": contact.phone !== null },
      (span) =>
        db.transaction(async (tx) => {
          const current = await readContact(tx, input.candidateId);
          // Two identical saves racing may both store a row; the details are the same either way.
          if (current !== null && same(current, contact))
            return { ok: true, value: { saved: false } } as const;
          const [row] = await tx
            .insert(profileContact)
            .values({ candidateId: input.candidateId, ...contact })
            .returning({ id: profileContact.id, createdAt: profileContact.createdAt });
          if (!row) throw new Error("profile_contact insert returned no row");
          await appendEvent(tx, span, {
            candidateId: input.candidateId,
            aggregate: `profile_contact:${row.id}`,
            type: "profile.contact_set",
            actor: "user",
            // Fixed words only: never a name, email or number.
            reason: "You updated your contact details",
            payload: { contactId: row.id, phone: contact.phone !== null },
            idempotencyKey: `profile_contact:${row.id}`,
            at: row.createdAt,
          });
          return { ok: true, value: { saved: true } } as const;
        }),
    );
  } catch {
    // A fresh error with no cause: the driver's message lists the query's parameters (the details).
    throw new Error("profile.contact_set failed");
  }
}
