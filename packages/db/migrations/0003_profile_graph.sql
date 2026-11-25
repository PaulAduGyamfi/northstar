CREATE TABLE "certification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"name" text NOT NULL,
	"issuer" text,
	"issued_month" text,
	CONSTRAINT "certification_issued_month_format" CHECK ("certification"."issued_month" is null or "certification"."issued_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
--> statement-breakpoint
CREATE TABLE "education" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"school" text NOT NULL,
	"degree" text,
	"field" text,
	"start_month" text,
	"end_month" text,
	"locked" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "education_start_month_format" CHECK ("education"."start_month" is null or "education"."start_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "education_end_month_format" CHECK ("education"."end_month" is null or "education"."end_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
--> statement-breakpoint
CREATE TABLE "experience_atom" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"role_id" uuid,
	"what" text NOT NULL,
	"how" text[] DEFAULT '{}'::text[] NOT NULL,
	"impact" text,
	"scope" text,
	"start_month" text,
	"end_month" text,
	"source_quote" text NOT NULL,
	"evidence_link" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "experience_atom_quote_not_empty" CHECK (length(trim("experience_atom"."source_quote")) > 0),
	CONSTRAINT "experience_atom_evidence_link_http" CHECK ("experience_atom"."evidence_link" is null or "experience_atom"."evidence_link" ~ '^https?://'),
	CONSTRAINT "experience_atom_start_month_format" CHECK ("experience_atom"."start_month" is null or "experience_atom"."start_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "experience_atom_end_month_format" CHECK ("experience_atom"."end_month" is null or "experience_atom"."end_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
--> statement-breakpoint
CREATE TABLE "profile_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"label" text NOT NULL,
	"url" text NOT NULL,
	CONSTRAINT "profile_link_url_http" CHECK ("profile_link"."url" ~ '^https?://')
);
--> statement-breakpoint
CREATE TABLE "profile_source" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"file_name" text NOT NULL,
	"text_sha256" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "profile_source_id_candidate_unique" UNIQUE("id","candidate_id"),
	CONSTRAINT "profile_source_kind_valid" CHECK ("profile_source"."kind" in ('resume')),
	CONSTRAINT "profile_source_sha_format" CHECK ("profile_source"."text_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "role" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"employer" text NOT NULL,
	"title" text NOT NULL,
	"start_month" text,
	"end_month" text,
	"locked" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_id_candidate_unique" UNIQUE("id","candidate_id"),
	CONSTRAINT "role_start_month_format" CHECK ("role"."start_month" is null or "role"."start_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "role_end_month_format" CHECK ("role"."end_month" is null or "role"."end_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
--> statement-breakpoint
CREATE TABLE "skill" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "skill_unique_per_source" UNIQUE("candidate_id","source_id","name")
);
--> statement-breakpoint
ALTER TABLE "certification" ADD CONSTRAINT "certification_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certification" ADD CONSTRAINT "certification_source_same_candidate_fk" FOREIGN KEY ("source_id","candidate_id") REFERENCES "public"."profile_source"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "education" ADD CONSTRAINT "education_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "education" ADD CONSTRAINT "education_source_same_candidate_fk" FOREIGN KEY ("source_id","candidate_id") REFERENCES "public"."profile_source"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_atom" ADD CONSTRAINT "experience_atom_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_atom" ADD CONSTRAINT "experience_atom_source_same_candidate_fk" FOREIGN KEY ("source_id","candidate_id") REFERENCES "public"."profile_source"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_atom" ADD CONSTRAINT "experience_atom_role_same_candidate_fk" FOREIGN KEY ("role_id","candidate_id") REFERENCES "public"."role"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_link" ADD CONSTRAINT "profile_link_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_link" ADD CONSTRAINT "profile_link_source_same_candidate_fk" FOREIGN KEY ("source_id","candidate_id") REFERENCES "public"."profile_source"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_source" ADD CONSTRAINT "profile_source_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role" ADD CONSTRAINT "role_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role" ADD CONSTRAINT "role_source_same_candidate_fk" FOREIGN KEY ("source_id","candidate_id") REFERENCES "public"."profile_source"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill" ADD CONSTRAINT "skill_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill" ADD CONSTRAINT "skill_source_same_candidate_fk" FOREIGN KEY ("source_id","candidate_id") REFERENCES "public"."profile_source"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "profile_source_one_current" ON "profile_source" USING btree ("candidate_id","kind") WHERE "profile_source"."superseded_at" is null;
