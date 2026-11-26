import type { ContactRefusal } from "@northstar/db";
import type { ContactDetails } from "@northstar/domain";

// `profile contact set|show` (NS-227 slice 3, APPLY-001): Paul's contact details, typed into each
// application form's standard fields. `show` prints his own details back to him in his terminal.

export type ContactCliDeps = {
  print: (line: string) => void;
  setContact: (
    contact: ContactDetails,
  ) => Promise<{ ok: true; value: { saved: boolean } } | { ok: false; error: ContactRefusal }>;
  readContact: () => Promise<ContactDetails | null>;
};

export const CONTACT_USAGE =
  "usage: profile contact set --first <name> --last <name> --email <address> [--phone <number>] | profile contact show";

const FLAGS = {
  "--first": "firstName",
  "--last": "lastName",
  "--email": "email",
  "--phone": "phone",
} as const;
type Flag = keyof typeof FLAGS;
const isFlag = (s: string): s is Flag => Object.hasOwn(FLAGS, s);

// Why a field was refused, in words.
const FIELD_HELP: Record<ContactRefusal["fields"][number], string> = {
  firstName: "--first takes 1 to 100 characters on one line",
  lastName: "--last takes 1 to 100 characters on one line",
  email: "--email takes one email address of at most 254 characters",
  phone: "--phone takes 1 to 40 characters on one line",
};

// The flags as pairs, each at most once; null for anything else, so the caller prints the usage.
function parseFlags(args: string[]): ContactDetails | null {
  if (args.length % 2 !== 0) return null;
  const seen = new Map<Flag, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i] ?? "";
    const value = args[i + 1];
    if (!isFlag(flag) || seen.has(flag) || value === undefined) return null;
    seen.set(flag, value);
  }
  const first = seen.get("--first");
  const last = seen.get("--last");
  const email = seen.get("--email");
  // All three are given every time; a missing phone means none.
  if (first === undefined || last === undefined || email === undefined) return null;
  return { firstName: first, lastName: last, email, phone: seen.get("--phone") ?? null };
}

export async function contactCommand(deps: ContactCliDeps, args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "show" && rest.length === 0) return contactShowCommand(deps);
  const contact = sub === "set" ? parseFlags(rest) : null;
  if (contact === null) {
    deps.print(CONTACT_USAGE);
    return 1;
  }
  const result = await deps.setContact(contact);
  if (!result.ok) {
    deps.print(`Not saved: ${result.error.fields.map((f) => FIELD_HELP[f]).join("; ")}.`);
    return 1;
  }
  deps.print(
    result.value.saved ? "Saved your contact details." : "Your contact details already say that.",
  );
  return 0;
}

// Paul's current details, one per line.
async function contactShowCommand(deps: ContactCliDeps): Promise<number> {
  const contact = await deps.readContact();
  if (contact === null) {
    deps.print("No contact details yet. Run: profile contact set --first … --last … --email …");
    return 0;
  }
  deps.print(`Name: ${contact.firstName} ${contact.lastName}`);
  deps.print(`Email: ${contact.email}`);
  deps.print(`Phone: ${contact.phone ?? "none"}`);
  return 0;
}
