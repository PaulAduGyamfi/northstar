CREATE TABLE "atom_line_edit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"atom_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"line" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "atom_line_edit_decision_unique" UNIQUE("decision_id"),
	CONSTRAINT "atom_line_edit_line_not_empty" CHECK (length(trim("atom_line_edit"."line")) > 0)
);
--> statement-breakpoint
CREATE TABLE "resume_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"profile_source_id" uuid NOT NULL,
	"targets" text[] NOT NULL,
	"scores" jsonb NOT NULL,
	"overall" integer NOT NULL,
	"pages" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resume_audit_id_candidate_unique" UNIQUE("id","candidate_id"),
	CONSTRAINT "resume_audit_overall_range" CHECK ("resume_audit"."overall" between 0 and 100),
	CONSTRAINT "resume_audit_pages_positive" CHECK ("resume_audit"."pages" >= 1)
);
--> statement-breakpoint
CREATE TABLE "resume_audit_decision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"audit_id" uuid NOT NULL,
	"key" text NOT NULL,
	"decision" text NOT NULL,
	"new_line" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resume_audit_decision_once" UNIQUE("audit_id","key"),
	CONSTRAINT "resume_audit_decision_id_candidate_unique" UNIQUE("id","candidate_id"),
	CONSTRAINT "resume_audit_decision_valid" CHECK (("resume_audit_decision"."decision" = 'accepted' and "resume_audit_decision"."new_line" is not null and length(trim("resume_audit_decision"."new_line")) > 0)
        or ("resume_audit_decision"."decision" = 'rejected' and "resume_audit_decision"."new_line" is null))
);
--> statement-breakpoint
CREATE TABLE "resume_audit_suggestion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"audit_id" uuid NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"dimension" text NOT NULL,
	"target" jsonb NOT NULL,
	"message" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "resume_audit_suggestion_key_unique" UNIQUE("audit_id","key"),
	CONSTRAINT "resume_audit_suggestion_position_unique" UNIQUE("audit_id","position"),
	CONSTRAINT "resume_audit_suggestion_key_not_empty" CHECK (length("resume_audit_suggestion"."key") > 0)
);
--> statement-breakpoint
ALTER TABLE "atom_line_edit" ADD CONSTRAINT "atom_line_edit_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atom_line_edit" ADD CONSTRAINT "atom_line_edit_atom_same_candidate_fk" FOREIGN KEY ("atom_id","candidate_id") REFERENCES "public"."experience_atom"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atom_line_edit" ADD CONSTRAINT "atom_line_edit_decision_same_candidate_fk" FOREIGN KEY ("decision_id","candidate_id") REFERENCES "public"."resume_audit_decision"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_audit" ADD CONSTRAINT "resume_audit_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_audit" ADD CONSTRAINT "resume_audit_source_same_candidate_fk" FOREIGN KEY ("profile_source_id","candidate_id") REFERENCES "public"."profile_source"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_audit_decision" ADD CONSTRAINT "resume_audit_decision_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_audit_decision" ADD CONSTRAINT "resume_audit_decision_audit_same_candidate_fk" FOREIGN KEY ("audit_id","candidate_id") REFERENCES "public"."resume_audit"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_audit_decision" ADD CONSTRAINT "resume_audit_decision_suggestion_fk" FOREIGN KEY ("audit_id","key") REFERENCES "public"."resume_audit_suggestion"("audit_id","key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_audit_suggestion" ADD CONSTRAINT "resume_audit_suggestion_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_audit_suggestion" ADD CONSTRAINT "resume_audit_suggestion_audit_same_candidate_fk" FOREIGN KEY ("audit_id","candidate_id") REFERENCES "public"."resume_audit"("id","candidate_id") ON DELETE no action ON UPDATE no action;
