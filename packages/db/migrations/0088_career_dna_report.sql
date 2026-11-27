CREATE TABLE "career_dna_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"rubric_version" integer NOT NULL,
	"family" text NOT NULL,
	"dimensions" jsonb NOT NULL,
	"archetype_label" text,
	"archetype_dimensions" jsonb NOT NULL,
	"content_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "career_dna_report_version_once" UNIQUE("candidate_id","version"),
	CONSTRAINT "career_dna_report_version_positive" CHECK ("career_dna_report"."version" >= 1),
	CONSTRAINT "career_dna_report_rubric_version_positive" CHECK ("career_dna_report"."rubric_version" >= 1),
	CONSTRAINT "career_dna_report_family_shape" CHECK ("career_dna_report"."family" ~ '^[a-z_]{1,40}$'),
	CONSTRAINT "career_dna_report_sha256_shape" CHECK ("career_dna_report"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "career_dna_report_archetype_shape" CHECK ("career_dna_report"."archetype_label" is null or char_length("career_dna_report"."archetype_label") between 1 and 60),
	CONSTRAINT "career_dna_report_lists_shape" CHECK (jsonb_typeof("career_dna_report"."dimensions") = 'array' and jsonb_array_length("career_dna_report"."dimensions") between 1 and 20 and jsonb_typeof("career_dna_report"."archetype_dimensions") = 'array' and jsonb_array_length("career_dna_report"."archetype_dimensions") <= 2)
);
--> statement-breakpoint
ALTER TABLE "career_dna_report" ADD CONSTRAINT "career_dna_report_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;
