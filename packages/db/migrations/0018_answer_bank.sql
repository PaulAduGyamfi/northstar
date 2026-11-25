CREATE TABLE "bank_answer" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"canonical_id" text NOT NULL,
	"kind" text NOT NULL,
	"version" integer NOT NULL,
	"short_text" text NOT NULL,
	"long_text" text,
	"approval_decision_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_answer_id_candidate_unique" UNIQUE("id","candidate_id"),
	CONSTRAINT "bank_answer_version_unique" UNIQUE("candidate_id","canonical_id","version"),
	CONSTRAINT "bank_answer_one_per_approval" UNIQUE("approval_decision_id"),
	CONSTRAINT "bank_answer_kind_valid" CHECK ("bank_answer"."kind" in ('reusable_narrative', 'company_specific')),
	CONSTRAINT "bank_answer_canonical_id_format" CHECK ("bank_answer"."canonical_id" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "bank_answer_version_positive" CHECK ("bank_answer"."version" >= 1),
	CONSTRAINT "bank_answer_short_not_empty" CHECK (length(trim("bank_answer"."short_text")) > 0),
	CONSTRAINT "bank_answer_long_not_empty" CHECK ("bank_answer"."long_text" is null or length(trim("bank_answer"."long_text")) > 0)
);
--> statement-breakpoint
CREATE TABLE "bank_answer_citation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"answer_id" uuid NOT NULL,
	"story_id" uuid,
	"atom_id" uuid,
	CONSTRAINT "bank_answer_citation_story_once" UNIQUE("answer_id","story_id"),
	CONSTRAINT "bank_answer_citation_atom_once" UNIQUE("answer_id","atom_id"),
	CONSTRAINT "bank_answer_citation_one_target" CHECK (num_nonnulls("bank_answer_citation"."story_id", "bank_answer_citation"."atom_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "bank_answer_use" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"answer_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"how" text NOT NULL,
	"edited" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_answer_use_once" UNIQUE("answer_id","application_id"),
	CONSTRAINT "bank_answer_use_how_valid" CHECK ("bank_answer_use"."how" in ('approved', 'reused')),
	CONSTRAINT "bank_answer_use_reuse_unedited" CHECK ("bank_answer_use"."how" = 'approved' or not "bank_answer_use"."edited")
);
--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_id_candidate_unique" UNIQUE("id","candidate_id");--> statement-breakpoint
ALTER TABLE "bank_answer" ADD CONSTRAINT "bank_answer_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_answer" ADD CONSTRAINT "bank_answer_decision_same_candidate_fk" FOREIGN KEY ("approval_decision_id","candidate_id") REFERENCES "public"."approval_decision"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_answer_citation" ADD CONSTRAINT "bank_answer_citation_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_answer_citation" ADD CONSTRAINT "bank_answer_citation_answer_same_candidate_fk" FOREIGN KEY ("answer_id","candidate_id") REFERENCES "public"."bank_answer"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_answer_citation" ADD CONSTRAINT "bank_answer_citation_story_same_candidate_fk" FOREIGN KEY ("story_id","candidate_id") REFERENCES "public"."story"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_answer_citation" ADD CONSTRAINT "bank_answer_citation_atom_same_candidate_fk" FOREIGN KEY ("atom_id","candidate_id") REFERENCES "public"."experience_atom"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_answer_use" ADD CONSTRAINT "bank_answer_use_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_answer_use" ADD CONSTRAINT "bank_answer_use_answer_same_candidate_fk" FOREIGN KEY ("answer_id","candidate_id") REFERENCES "public"."bank_answer"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_answer_use" ADD CONSTRAINT "bank_answer_use_application_same_candidate_fk" FOREIGN KEY ("application_id","candidate_id") REFERENCES "public"."application"("id","candidate_id") ON DELETE no action ON UPDATE no action;
