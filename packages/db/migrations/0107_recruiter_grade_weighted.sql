ALTER TABLE "recruiter_grade" ADD COLUMN "weighted_grade" text;--> statement-breakpoint
ALTER TABLE "recruiter_grade" ADD COLUMN "weighted_points" integer;--> statement-breakpoint
ALTER TABLE "recruiter_grade" ADD COLUMN "weights_position" bigint;--> statement-breakpoint
ALTER TABLE "recruiter_grade" ADD CONSTRAINT "recruiter_grade_weighted_whole" CHECK (("recruiter_grade"."weighted_grade" is null and "recruiter_grade"."weighted_points" is null and "recruiter_grade"."weights_position" is null) or ("recruiter_grade"."weighted_grade" in ('A', 'B', 'C', 'D', 'F') and "recruiter_grade"."weighted_points" between "recruiter_grade"."points" - 2 and "recruiter_grade"."points" + 2 and "recruiter_grade"."weights_position" > 0));
