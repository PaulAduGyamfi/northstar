// The company name comes from job data (an ATS, a page's JSON-LD, a model's reading of a page),
// and a banked answer's {company} slot filled with it may go out under Paul's name having been
// approved only as a template. So only a plain short name is filled in: letters, digits, spaces
// and & ' - , ( ) and a dot only inside a word (Inc., Booking.com), no sentence, URL, address or
// line break. Shared by adaptAnswer (packages/profile) and the Gate's claim check (NS-213).
const MAX_COMPANY_LENGTH = 80;
const SAFE_COMPANY = /^[\p{L}\p{N}][\p{L}\p{N} &'’,()-]*(?:\.[\p{L}\p{N} &'’,()-]+)*\.?$/u;
const LOOKS_LIKE_LINK = /\b(?:https?|www)\b|\.(?:com|net|org|io|co)\b.*\s/i;

export function isSafeCompany(name: string): boolean {
  return (
    name.length <= MAX_COMPANY_LENGTH && SAFE_COMPANY.test(name) && !LOOKS_LIKE_LINK.test(name)
  );
}
