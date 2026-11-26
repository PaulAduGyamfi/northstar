CREATE TABLE "independent_work_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"set_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"started_on" text NOT NULL,
	"ended_on" text,
	"link" text,
	CONSTRAINT "independent_work_entry_id_candidate_unique" UNIQUE("id","candidate_id"),
	CONSTRAINT "independent_work_entry_position_unique" UNIQUE("set_id","position"),
	CONSTRAINT "independent_work_entry_position_valid" CHECK ("independent_work_entry"."position" between 0 and 9),
	CONSTRAINT "independent_work_entry_title_shape" CHECK (length(trim("independent_work_entry"."title")) between 1 and 80 and "independent_work_entry"."title" !~ '[[:cntrl:]]'),
	CONSTRAINT "independent_work_entry_start_format" CHECK ("independent_work_entry"."started_on" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "independent_work_entry_end_format" CHECK ("independent_work_entry"."ended_on" is null or ("independent_work_entry"."ended_on" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' and "independent_work_entry"."ended_on" >= "independent_work_entry"."started_on")),
	CONSTRAINT "independent_work_entry_link_https" CHECK ("independent_work_entry"."link" is null or ("independent_work_entry"."link" ~ '^https://' and length("independent_work_entry"."link") <= 300 and "independent_work_entry"."link" !~ '[[:cntrl:]]'))
);
--> statement-breakpoint
CREATE TABLE "independent_work_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL,
	CONSTRAINT "independent_work_line_position_unique" UNIQUE("entry_id","position"),
	CONSTRAINT "independent_work_line_position_valid" CHECK ("independent_work_line"."position" between 0 and 5),
	CONSTRAINT "independent_work_line_text_shape" CHECK (length(trim("independent_work_line"."text")) between 1 and 200 and "independent_work_line"."text" !~ '[[:cntrl:]]')
);
--> statement-breakpoint
CREATE TABLE "independent_work_set" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "independent_work_set_id_candidate_unique" UNIQUE("id","candidate_id"),
	CONSTRAINT "independent_work_set_version_unique" UNIQUE("candidate_id","version"),
	CONSTRAINT "independent_work_set_version_positive" CHECK ("independent_work_set"."version" >= 1),
	CONSTRAINT "independent_work_set_sha256_format" CHECK ("independent_work_set"."content_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "independent_work_entry" ADD CONSTRAINT "independent_work_entry_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "independent_work_entry" ADD CONSTRAINT "independent_work_entry_set_same_candidate_fk" FOREIGN KEY ("set_id","candidate_id") REFERENCES "public"."independent_work_set"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "independent_work_line" ADD CONSTRAINT "independent_work_line_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "independent_work_line" ADD CONSTRAINT "independent_work_line_entry_same_candidate_fk" FOREIGN KEY ("entry_id","candidate_id") REFERENCES "public"."independent_work_entry"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "independent_work_set" ADD CONSTRAINT "independent_work_set_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;
