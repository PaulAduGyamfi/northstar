CREATE TABLE "growth_milestone" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"track_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"done_on" date,
	CONSTRAINT "growth_milestone_position_unique" UNIQUE("track_id","position"),
	CONSTRAINT "growth_milestone_position_range" CHECK ("growth_milestone"."position" between 0 and 19),
	CONSTRAINT "growth_milestone_title_shape" CHECK (length(trim("growth_milestone"."title")) between 1 and 200 and "growth_milestone"."title" !~ '[[:cntrl:]]')
);
--> statement-breakpoint
ALTER TABLE "growth_track" ADD COLUMN "goal" text;--> statement-breakpoint
ALTER TABLE "growth_track" ADD COLUMN "done_when" text;--> statement-breakpoint
ALTER TABLE "growth_track" ADD CONSTRAINT "growth_track_id_candidate_unique" UNIQUE("id","candidate_id");--> statement-breakpoint
ALTER TABLE "growth_milestone" ADD CONSTRAINT "growth_milestone_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_milestone" ADD CONSTRAINT "growth_milestone_track_same_candidate_fk" FOREIGN KEY ("track_id","candidate_id") REFERENCES "public"."growth_track"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_track" ADD CONSTRAINT "growth_track_goal_shape" CHECK ("growth_track"."goal" is null or (length(trim("growth_track"."goal")) between 1 and 300 and "growth_track"."goal" !~ '[[:cntrl:]]'));--> statement-breakpoint
ALTER TABLE "growth_track" ADD CONSTRAINT "growth_track_done_when_shape" CHECK ("growth_track"."done_when" is null or (length(trim("growth_track"."done_when")) between 1 and 300 and "growth_track"."done_when" !~ '[[:cntrl:]]'));
