-- The answer bank is append-only (GH-59, ANS-006): Paul approved these words, so an answer, what
-- it cites and where it was used are each written once. A changed answer is a new version.
CREATE FUNCTION answer_bank_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER bank_answer_no_update_or_delete
  BEFORE UPDATE OR DELETE ON bank_answer
  FOR EACH ROW EXECUTE FUNCTION answer_bank_reject_change();
--> statement-breakpoint
CREATE TRIGGER bank_answer_no_truncate
  BEFORE TRUNCATE ON bank_answer
  FOR EACH STATEMENT EXECUTE FUNCTION answer_bank_reject_change();
--> statement-breakpoint
CREATE TRIGGER bank_answer_citation_no_update_or_delete
  BEFORE UPDATE OR DELETE ON bank_answer_citation
  FOR EACH ROW EXECUTE FUNCTION answer_bank_reject_change();
--> statement-breakpoint
CREATE TRIGGER bank_answer_citation_no_truncate
  BEFORE TRUNCATE ON bank_answer_citation
  FOR EACH STATEMENT EXECUTE FUNCTION answer_bank_reject_change();
--> statement-breakpoint
CREATE TRIGGER bank_answer_use_no_update_or_delete
  BEFORE UPDATE OR DELETE ON bank_answer_use
  FOR EACH ROW EXECUTE FUNCTION answer_bank_reject_change();
--> statement-breakpoint
CREATE TRIGGER bank_answer_use_no_truncate
  BEFORE TRUNCATE ON bank_answer_use
  FOR EACH STATEMENT EXECUTE FUNCTION answer_bank_reject_change();
