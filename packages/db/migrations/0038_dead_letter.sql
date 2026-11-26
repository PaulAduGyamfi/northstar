CREATE TABLE "dead_letter" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"reason_code" text NOT NULL,
	"attempts" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"dead_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dead_letter_id_candidate_unique" UNIQUE("id","candidate_id"),
	CONSTRAINT "dead_letter_idempotency_unique" UNIQUE("candidate_id","idempotency_key"),
	CONSTRAINT "dead_letter_kind_valid" CHECK ("dead_letter"."kind" ~ '^[a-z0-9]+([_.:-][a-z0-9]+)*$' and length("dead_letter"."kind") <= 64),
	CONSTRAINT "dead_letter_subject_valid" CHECK ("dead_letter"."subject" ~ '^[a-z_]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
	CONSTRAINT "dead_letter_reason_valid" CHECK ("dead_letter"."reason_code" ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "dead_letter_attempts_positive" CHECK ("dead_letter"."attempts" >= 1),
	CONSTRAINT "dead_letter_key_valid" CHECK ("dead_letter"."idempotency_key" ~ '^[a-z0-9][a-z0-9_.:-]{0,199}$')
);
--> statement-breakpoint
CREATE TABLE "dead_letter_resolution" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"dead_letter_id" uuid NOT NULL,
	"action" text NOT NULL,
	"actor" text NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dead_letter_resolution_one_per_letter" UNIQUE("dead_letter_id"),
	CONSTRAINT "dead_letter_resolution_action_valid" CHECK ("dead_letter_resolution"."action" in ('retry', 'skip', 'hand_off')),
	CONSTRAINT "dead_letter_resolution_actor_valid" CHECK ("dead_letter_resolution"."actor" in ('user', 'system'))
);
--> statement-breakpoint
ALTER TABLE "dead_letter" ADD CONSTRAINT "dead_letter_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dead_letter_resolution" ADD CONSTRAINT "dead_letter_resolution_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dead_letter_resolution" ADD CONSTRAINT "dead_letter_resolution_same_candidate_fk" FOREIGN KEY ("dead_letter_id","candidate_id") REFERENCES "public"."dead_letter"("id","candidate_id") ON DELETE no action ON UPDATE no action;
