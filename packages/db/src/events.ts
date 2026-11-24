import { DomainEvent } from "@northstar/domain";
import type { domainEvent } from "./schema.js";

// An event as stored: the domain event plus its place in the log (ADR-0012).
export type StoredEvent = { event: DomainEvent; position: bigint };

// Turns a domain_event row back into a checked DomainEvent. Parsing again on the way out brands
// the ids and fails loudly if a row ever stops matching the schema.
export function rowToStoredEvent(row: typeof domainEvent.$inferSelect): StoredEvent {
  const { position, ...fields } = row;
  return { event: DomainEvent.parse(fields), position };
}
