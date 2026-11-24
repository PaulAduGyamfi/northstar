CREATE TABLE "application" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_one_per_job" UNIQUE("candidate_id","job_id"),
	CONSTRAINT "application_status_valid" CHECK ("application"."status" in ('discovered', 'scored', 'queued', 'package_ready', 'awaiting_approval', 'submitting', 'needs_human', 'submitted', 'confirmed', 'in_process', 'offer', 'rejected', 'withdrawn', 'ghosted'))
);
--> statement-breakpoint
CREATE TABLE "candidate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_id_candidate_unique" UNIQUE("id","candidate_id")
);
--> statement-breakpoint
CREATE TABLE "domain_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"position" bigint GENERATED ALWAYS AS IDENTITY (sequence name "domain_event_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"candidate_id" uuid NOT NULL,
	"aggregate" text NOT NULL,
	"type" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text NOT NULL,
	"inputs_summary" text NOT NULL,
	"payload" jsonb NOT NULL,
	"links" jsonb NOT NULL,
	"trace_id" text,
	"idempotency_key" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "domain_event_idempotency_unique" UNIQUE("candidate_id","idempotency_key"),
	CONSTRAINT "domain_event_position_unique" UNIQUE("position"),
	CONSTRAINT "domain_event_trace_id_format" CHECK ("domain_event"."trace_id" is null or "domain_event"."trace_id" ~ '^[0-9a-f]{32}$')
);
--> statement-breakpoint
CREATE TABLE "job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_id_candidate_unique" UNIQUE("id","candidate_id")
);
--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_job_same_candidate_fk" FOREIGN KEY ("job_id","candidate_id") REFERENCES "public"."job"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company" ADD CONSTRAINT "company_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_event" ADD CONSTRAINT "domain_event_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_company_same_candidate_fk" FOREIGN KEY ("company_id","candidate_id") REFERENCES "public"."company"("id","candidate_id") ON DELETE no action ON UPDATE no action;