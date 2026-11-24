import { z } from "zod";

// Branded uuids: at runtime they are plain strings, but the type checker refuses to pass one kind
// of id where another is expected (an ApplicationId where a CandidateId belongs).
export const CandidateId = z.uuid().brand<"CandidateId">();
export type CandidateId = z.infer<typeof CandidateId>;

export const CompanyId = z.uuid().brand<"CompanyId">();
export type CompanyId = z.infer<typeof CompanyId>;

export const JobId = z.uuid().brand<"JobId">();
export type JobId = z.infer<typeof JobId>;

export const ApplicationId = z.uuid().brand<"ApplicationId">();
export type ApplicationId = z.infer<typeof ApplicationId>;

export const EventId = z.uuid().brand<"EventId">();
export type EventId = z.infer<typeof EventId>;
