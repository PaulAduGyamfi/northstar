// Every reason a recruiter grade can give (REC-001, NS-167/NS-238): `<factor>:<outcome>` codes from
// gradeRecruiterMessage (@northstar/sources), and the one list the store, the API and the event
// accept. A fixed list, not a pattern, so no reason can carry words from an email.
export const RECRUITER_GRADE_REASONS = [
  "title:exact",
  "title:partial",
  "title:none",
  "title:unknown",
  "title:level_mismatch",
  "pay:ok",
  "pay:below",
  "pay:unknown",
  "place:ok",
  "place:mismatch",
  "place:unknown",
  "sender:agency",
  "sender:in_house",
  "sender:unknown",
  "personal:yes",
  "personal:no",
  "company:named",
  "company:unnamed",
  "dealbreaker",
  "red_flag:upfront_fee",
  "red_flag:sensitive_data",
  "red_flag:vague_role",
  "red_flag:unpaid_work",
] as const;
export type RecruiterGradeReason = (typeof RECRUITER_GRADE_REASONS)[number];
