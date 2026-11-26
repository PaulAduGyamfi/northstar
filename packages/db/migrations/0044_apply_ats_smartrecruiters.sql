ALTER TABLE "apply_submission" DROP CONSTRAINT "apply_submission_ats_valid";--> statement-breakpoint
ALTER TABLE "apply_submission" ADD CONSTRAINT "apply_submission_ats_valid" CHECK ("apply_submission"."ats" in ('greenhouse', 'lever', 'ashby', 'smartrecruiters'));
