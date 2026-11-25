CREATE TABLE "employment_fact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"employer" text NOT NULL,
	"title" text NOT NULL,
	"start_date" text NOT NULL,
	"end_date" text,
	"is_current" boolean NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "employment_fact_start_format" CHECK ("employment_fact"."start_date" ~ '^[0-9]{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12][0-9]|3[01]))?$'),
	CONSTRAINT "employment_fact_end_format" CHECK ("employment_fact"."end_date" is null or "employment_fact"."end_date" ~ '^[0-9]{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12][0-9]|3[01]))?$'),
	CONSTRAINT "employment_fact_current_xor_end" CHECK ("employment_fact"."is_current" = ("employment_fact"."end_date" is null)),
	CONSTRAINT "employment_fact_not_blank" CHECK (length(trim("employment_fact"."employer")) > 0 and length(trim("employment_fact"."title")) > 0)
);
--> statement-breakpoint
ALTER TABLE "employment_fact" ADD CONSTRAINT "employment_fact_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "employment_fact_one_active_position" ON "employment_fact" USING btree ("candidate_id","position") WHERE "employment_fact"."superseded_at" is null;