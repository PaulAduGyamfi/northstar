CREATE TABLE "growth_plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"track_set_version" integer NOT NULL,
	"plan" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "growth_plan_week_unique" UNIQUE("candidate_id","week_start"),
	CONSTRAINT "growth_plan_monday" CHECK (extract(isodow from "growth_plan"."week_start") = 1)
);
--> statement-breakpoint
CREATE TABLE "growth_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"weekly_minutes" integer NOT NULL,
	"wip_limit" integer NOT NULL,
	"block_minutes" integer NOT NULL,
	"maintenance_minutes" integer NOT NULL,
	"min_focus_sessions" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "growth_settings_ranges" CHECK ("growth_settings"."weekly_minutes" between 0 and 10080 and "growth_settings"."wip_limit" between 1 and 10 and "growth_settings"."block_minutes" between 15 and 90 and "growth_settings"."maintenance_minutes" between 15 and 90 and "growth_settings"."min_focus_sessions" between 1 and 7)
);
--> statement-breakpoint
CREATE TABLE "growth_touch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"track_key" text NOT NULL,
	"touched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "growth_touch_key_format" CHECK ("growth_touch"."track_key" ~ '^[a-z0-9][a-z0-9-]{0,39}$')
);
--> statement-breakpoint
CREATE TABLE "growth_track" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"set_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"priority" integer NOT NULL,
	"target_date" date,
	"untouched_days" integer NOT NULL,
	"next_title" text,
	"next_minutes" integer,
	CONSTRAINT "growth_track_key_unique" UNIQUE("set_id","key"),
	CONSTRAINT "growth_track_key_format" CHECK ("growth_track"."key" ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
	CONSTRAINT "growth_track_name_shape" CHECK (length(trim("growth_track"."name")) between 1 and 120 and "growth_track"."name" !~ '[[:cntrl:]]'),
	CONSTRAINT "growth_track_type_valid" CHECK ("growth_track"."type" in ('project', 'course', 'cert', 'skill')),
	CONSTRAINT "growth_track_status_valid" CHECK ("growth_track"."status" in ('active', 'paused', 'backlogged', 'done')),
	CONSTRAINT "growth_track_priority_range" CHECK ("growth_track"."priority" between 1 and 5),
	CONSTRAINT "growth_track_untouched_range" CHECK ("growth_track"."untouched_days" between 1 and 365),
	CONSTRAINT "growth_track_next_title_shape" CHECK ("growth_track"."next_title" is null or (length(trim("growth_track"."next_title")) between 1 and 200 and "growth_track"."next_title" !~ '[[:cntrl:]]')),
	CONSTRAINT "growth_track_next_pair" CHECK (("growth_track"."next_title" is null) = ("growth_track"."next_minutes" is null) and ("growth_track"."next_minutes" is null or "growth_track"."next_minutes" >= 1))
);
--> statement-breakpoint
CREATE TABLE "growth_track_set" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "growth_track_set_id_candidate_unique" UNIQUE("id","candidate_id"),
	CONSTRAINT "growth_track_set_version_unique" UNIQUE("candidate_id","version"),
	CONSTRAINT "growth_track_set_version_positive" CHECK ("growth_track_set"."version" >= 1),
	CONSTRAINT "growth_track_set_sha256_format" CHECK ("growth_track_set"."content_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "growth_plan" ADD CONSTRAINT "growth_plan_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_settings" ADD CONSTRAINT "growth_settings_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_touch" ADD CONSTRAINT "growth_touch_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_track" ADD CONSTRAINT "growth_track_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_track" ADD CONSTRAINT "growth_track_set_same_candidate_fk" FOREIGN KEY ("set_id","candidate_id") REFERENCES "public"."growth_track_set"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_track_set" ADD CONSTRAINT "growth_track_set_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;
