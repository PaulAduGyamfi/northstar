ALTER TABLE "profile_source" DROP CONSTRAINT "profile_source_kind_valid";--> statement-breakpoint
ALTER TABLE "profile_source" ADD CONSTRAINT "profile_source_kind_valid" CHECK ("profile_source"."kind" in ('resume', 'linkedin'));
