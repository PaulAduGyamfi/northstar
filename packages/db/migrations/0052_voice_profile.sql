CREATE TABLE "voice_edit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"deleted" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voice_edit_subject_unique" UNIQUE("candidate_id","subject"),
	CONSTRAINT "voice_edit_subject_shape" CHECK ("voice_edit"."subject" ~ '^[a-z_]+:[A-Za-z0-9_-]+$' and char_length("voice_edit"."subject") <= 160),
	CONSTRAINT "voice_edit_deleted_count" CHECK (coalesce(array_length("voice_edit"."deleted", 1), 0) between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "voice_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"samples" integer NOT NULL,
	"words" integer NOT NULL,
	"sentence_words" double precision NOT NULL,
	"contractions_per_100" double precision NOT NULL,
	"i_per_100" double precision NOT NULL,
	"we_per_100" double precision NOT NULL,
	"exclamation_share" double precision NOT NULL,
	"phrases" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voice_profile_version_unique" UNIQUE("candidate_id","version"),
	CONSTRAINT "voice_profile_id_candidate_unique" UNIQUE("id","candidate_id"),
	CONSTRAINT "voice_profile_version_positive" CHECK ("voice_profile"."version" >= 1),
	CONSTRAINT "voice_profile_samples_range" CHECK ("voice_profile"."samples" between 1 and 100),
	CONSTRAINT "voice_profile_words_valid" CHECK ("voice_profile"."words" >= 0),
	CONSTRAINT "voice_profile_share_range" CHECK ("voice_profile"."exclamation_share" between 0 and 1),
	CONSTRAINT "voice_profile_phrases_count" CHECK (coalesce(array_length("voice_profile"."phrases", 1), 0) <= 50)
);
--> statement-breakpoint
CREATE TABLE "voice_review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"kept" text[] NOT NULL,
	"dropped" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "voice_edit" ADD CONSTRAINT "voice_edit_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_profile" ADD CONSTRAINT "voice_profile_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_review" ADD CONSTRAINT "voice_review_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_review" ADD CONSTRAINT "voice_review_profile_same_candidate_fk" FOREIGN KEY ("profile_id","candidate_id") REFERENCES "public"."voice_profile"("id","candidate_id") ON DELETE no action ON UPDATE no action;
