ALTER TABLE "fit_score" DROP CONSTRAINT "fit_score_method_valid";--> statement-breakpoint
ALTER TABLE "fit_score" ADD CONSTRAINT "fit_score_method_valid" CHECK ("fit_score"."method" in ('rules', 'rules_model'));
