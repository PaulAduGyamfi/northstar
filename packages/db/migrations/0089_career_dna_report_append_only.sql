-- Career DNA report versions are append-only (NS-130 slice 4, DNA-008, ADR-0012): a changed report
-- is a new version row. Reuses the Approval Gate's reject function (migration 0016), then grants the
-- app role by the NS-212 rule (migration 0065).
CREATE TRIGGER career_dna_report_no_update_or_delete
  BEFORE UPDATE OR DELETE ON career_dna_report
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER career_dna_report_no_truncate
  BEFORE TRUNCATE ON career_dna_report
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
SELECT northstar_grant_app_role();
