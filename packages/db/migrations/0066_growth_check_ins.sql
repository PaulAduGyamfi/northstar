-- NS-214. The app role's grants come in 0067, after the append-only triggers: granting here
-- would give northstar_app full writes on these tables until 0067 ran.
CREATE TABLE "growth_check_in" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"track_key" text NOT NULL,
	"checked_in_at" timestamp with time zone DEFAULT now() NOT NULL,
	"minutes" integer NOT NULL,
	"percent" real,
	"idempotency_key" text NOT NULL,
	CONSTRAINT "growth_check_in_idempotency_unique" UNIQUE("candidate_id","idempotency_key"),
	CONSTRAINT "growth_check_in_key_format" CHECK ("growth_check_in"."track_key" ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
	CONSTRAINT "growth_check_in_minutes_range" CHECK ("growth_check_in"."minutes" between 1 and 600),
	CONSTRAINT "growth_check_in_percent_range" CHECK ("growth_check_in"."percent" is null or ("growth_check_in"."percent" >= 0 and "growth_check_in"."percent" <= 100)),
	CONSTRAINT "growth_check_in_idempotency_shape" CHECK ("growth_check_in"."idempotency_key" ~ '^[A-Za-z0-9_:-]{8,100}$')
);
--> statement-breakpoint
CREATE TABLE "growth_review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"review" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "growth_review_week_unique" UNIQUE("candidate_id","week_start"),
	CONSTRAINT "growth_review_monday" CHECK (extract(isodow from "growth_review"."week_start") = 1)
);
--> statement-breakpoint
ALTER TABLE "growth_check_in" ADD CONSTRAINT "growth_check_in_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_review" ADD CONSTRAINT "growth_review_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;
