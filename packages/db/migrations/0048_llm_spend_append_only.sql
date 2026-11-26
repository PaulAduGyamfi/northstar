-- LLM spend is append-only (NS-176, RES-009, ADR-0021): one row per model reply, never edited, so
-- the cap reads what was really spent. Reuses the Approval Gate's reject function (migration 0016).
CREATE TRIGGER llm_spend_no_update_or_delete
  BEFORE UPDATE OR DELETE ON llm_spend
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER llm_spend_no_truncate
  BEFORE TRUNCATE ON llm_spend
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
