CREATE TABLE "fit_score" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"preference_id" uuid NOT NULL,
	"profile_source_id" uuid NOT NULL,
	"job_fingerprint" text NOT NULL,
	"score" integer NOT NULL,
	"band" text NOT NULL,
	"reason" text NOT NULL,
	"stretch" boolean NOT NULL,
	"components" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"method" text NOT NULL,
	"scored_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fit_score_key_unique" UNIQUE("candidate_id","job_id","preference_id","profile_source_id","job_fingerprint"),
	CONSTRAINT "fit_score_range" CHECK ("fit_score"."score" between 0 and 100),
	CONSTRAINT "fit_score_band_valid" CHECK ("fit_score"."band" in ('queue', 'suggest', 'skip')),
	CONSTRAINT "fit_score_method_valid" CHECK ("fit_score"."method" in ('rules')),
	CONSTRAINT "fit_score_fingerprint_format" CHECK ("fit_score"."job_fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "search_preference" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"titles" text[] DEFAULT '{}'::text[] NOT NULL,
	"seniority" text[] DEFAULT '{}'::text[] NOT NULL,
	"locations" text[] DEFAULT '{}'::text[] NOT NULL,
	"remote" text[] DEFAULT '{}'::text[] NOT NULL,
	"dealbreakers" text[] DEFAULT '{}'::text[] NOT NULL,
	"comp_floor" integer,
	"comp_target" integer,
	"currency" text DEFAULT 'USD' NOT NULL,
	"queue_at" integer DEFAULT 80 NOT NULL,
	"suggest_at" integer DEFAULT 60 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_preference_version_unique" UNIQUE("candidate_id","version"),
	CONSTRAINT "search_preference_id_candidate_unique" UNIQUE("id","candidate_id"),
	CONSTRAINT "search_preference_version_positive" CHECK ("search_preference"."version" >= 1),
	CONSTRAINT "search_preference_remote_valid" CHECK ("search_preference"."remote" <@ array['onsite', 'hybrid', 'remote']::text[]),
	CONSTRAINT "search_preference_thresholds" CHECK ("search_preference"."suggest_at" between 0 and 100 and "search_preference"."queue_at" between 0 and 100 and "search_preference"."suggest_at" <= "search_preference"."queue_at"),
	CONSTRAINT "search_preference_comp_order" CHECK ("search_preference"."comp_floor" is null or "search_preference"."comp_target" is null or "search_preference"."comp_floor" <= "search_preference"."comp_target"),
	CONSTRAINT "search_preference_comp_nonnegative" CHECK (coalesce("search_preference"."comp_floor", 0) >= 0 and coalesce("search_preference"."comp_target", 0) >= 0),
	CONSTRAINT "search_preference_currency_format" CHECK ("search_preference"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "fit_score" ADD CONSTRAINT "fit_score_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fit_score" ADD CONSTRAINT "fit_score_job_same_candidate_fk" FOREIGN KEY ("job_id","candidate_id") REFERENCES "public"."job"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fit_score" ADD CONSTRAINT "fit_score_preference_same_candidate_fk" FOREIGN KEY ("preference_id","candidate_id") REFERENCES "public"."search_preference"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fit_score" ADD CONSTRAINT "fit_score_profile_source_same_candidate_fk" FOREIGN KEY ("profile_source_id","candidate_id") REFERENCES "public"."profile_source"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_preference" ADD CONSTRAINT "search_preference_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;
