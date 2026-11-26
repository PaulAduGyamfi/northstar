-- Stored application packages are append-only (NS-192, ADR-0012): a package is stored once per
-- Gate request, and what Paul approved never changes behind it. Reuses the Approval Gate's reject
-- function (migration 0016), then grants the app role by the NS-212 rule (migration 0065).
CREATE TRIGGER application_package_no_update_or_delete
  BEFORE UPDATE OR DELETE ON application_package
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER application_package_no_truncate
  BEFORE TRUNCATE ON application_package
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
SELECT northstar_grant_app_role();
