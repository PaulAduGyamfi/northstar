ALTER TABLE "role" ADD CONSTRAINT "role_current_has_no_end" CHECK (not "role"."is_current" or "role"."end_month" is null);
