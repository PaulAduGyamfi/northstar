-- The story bank's same-candidate foreign keys point at (id, candidate_id), so the unique key comes first.
ALTER TABLE "experience_atom" ADD CONSTRAINT "experience_atom_id_candidate_unique" UNIQUE("id","candidate_id");--> statement-breakpoint
CREATE TABLE "story" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"interview_id" uuid NOT NULL,
	"title" text NOT NULL,
	"situation" text NOT NULL,
	"task" text NOT NULL,
	"action" text NOT NULL,
	"result" text NOT NULL,
	"competencies" text[] NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"prompt_version" integer NOT NULL,
	"model" text NOT NULL,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "story_id_candidate_unique" UNIQUE("id","candidate_id"),
	CONSTRAINT "story_status_valid" CHECK ("story"."status" in ('draft', 'approved', 'rejected')),
	CONSTRAINT "story_approved_at_matches_status" CHECK (("story"."status" = 'approved') = ("story"."approved_at" is not null)),
	CONSTRAINT "story_competencies_valid" CHECK (cardinality("story"."competencies") between 1 and 3 and "story"."competencies" <@ array['leadership', 'conflict', 'ambiguity', 'scale', 'failure', 'ownership', 'collaboration', 'technical-depth', 'customer-impact', 'learning']::text[]),
	CONSTRAINT "story_parts_not_empty" CHECK (length(trim("story"."title")) > 0 and length(trim("story"."situation")) > 0 and length(trim("story"."task")) > 0 and length(trim("story"."action")) > 0 and length(trim("story"."result")) > 0)
);
--> statement-breakpoint
CREATE TABLE "story_answer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"interview_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "story_answer_one_per_position" UNIQUE("interview_id","position"),
	CONSTRAINT "story_answer_position_valid" CHECK ("story_answer"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "story_atom" (
	"candidate_id" uuid NOT NULL,
	"story_id" uuid NOT NULL,
	"atom_id" uuid NOT NULL,
	CONSTRAINT "story_atom_pk" PRIMARY KEY("story_id","atom_id")
);
--> statement-breakpoint
CREATE TABLE "story_interview" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"atom_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "story_interview_id_candidate_unique" UNIQUE("id","candidate_id"),
	CONSTRAINT "story_interview_status_valid" CHECK ("story_interview"."status" in ('open', 'drafted', 'abandoned'))
);
--> statement-breakpoint
ALTER TABLE "story" ADD CONSTRAINT "story_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story" ADD CONSTRAINT "story_interview_same_candidate_fk" FOREIGN KEY ("interview_id","candidate_id") REFERENCES "public"."story_interview"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_answer" ADD CONSTRAINT "story_answer_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_answer" ADD CONSTRAINT "story_answer_interview_same_candidate_fk" FOREIGN KEY ("interview_id","candidate_id") REFERENCES "public"."story_interview"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_atom" ADD CONSTRAINT "story_atom_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_atom" ADD CONSTRAINT "story_atom_story_same_candidate_fk" FOREIGN KEY ("story_id","candidate_id") REFERENCES "public"."story"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_atom" ADD CONSTRAINT "story_atom_atom_same_candidate_fk" FOREIGN KEY ("atom_id","candidate_id") REFERENCES "public"."experience_atom"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_interview" ADD CONSTRAINT "story_interview_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_interview" ADD CONSTRAINT "story_interview_atom_same_candidate_fk" FOREIGN KEY ("atom_id","candidate_id") REFERENCES "public"."experience_atom"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "story_interview_one_open_per_atom" ON "story_interview" USING btree ("candidate_id","atom_id") WHERE "story_interview"."status" = 'open';
