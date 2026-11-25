CREATE TABLE "positioning_thesis" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"text" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "positioning_thesis_id_candidate_unique" UNIQUE("id","candidate_id"),
	CONSTRAINT "positioning_thesis_version_unique" UNIQUE("candidate_id","version"),
	CONSTRAINT "positioning_thesis_version_positive" CHECK ("positioning_thesis"."version" >= 1),
	CONSTRAINT "positioning_thesis_text_shape" CHECK (length(trim("positioning_thesis"."text")) between 1 and 200 and position(E'\n' in "positioning_thesis"."text") = 0)
);
--> statement-breakpoint
CREATE TABLE "positioning_thesis_atom" (
	"candidate_id" uuid NOT NULL,
	"thesis_id" uuid NOT NULL,
	"atom_id" uuid NOT NULL,
	CONSTRAINT "positioning_thesis_atom_pk" PRIMARY KEY("thesis_id","atom_id")
);
--> statement-breakpoint
ALTER TABLE "positioning_thesis" ADD CONSTRAINT "positioning_thesis_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positioning_thesis_atom" ADD CONSTRAINT "positioning_thesis_atom_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positioning_thesis_atom" ADD CONSTRAINT "positioning_thesis_atom_thesis_same_candidate_fk" FOREIGN KEY ("thesis_id","candidate_id") REFERENCES "public"."positioning_thesis"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positioning_thesis_atom" ADD CONSTRAINT "positioning_thesis_atom_atom_same_candidate_fk" FOREIGN KEY ("atom_id","candidate_id") REFERENCES "public"."experience_atom"("id","candidate_id") ON DELETE no action ON UPDATE no action;
