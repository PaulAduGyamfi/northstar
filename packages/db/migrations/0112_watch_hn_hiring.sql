ALTER TABLE "company_watch" DROP CONSTRAINT "company_watch_ats_valid";--> statement-breakpoint
ALTER TABLE "company_watch" ADD CONSTRAINT "company_watch_ats_valid" CHECK ("company_watch"."ats" in ('greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'workable', 'hn_hiring'));
