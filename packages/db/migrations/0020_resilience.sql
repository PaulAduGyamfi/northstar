CREATE TABLE "dependency_breaker" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"dependency" text NOT NULL,
	"status" text NOT NULL,
	"consecutive_failures" integer NOT NULL,
	"opens" integer NOT NULL,
	"retry_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "dependency_breaker_one_per_dependency" UNIQUE("candidate_id","dependency"),
	CONSTRAINT "dependency_breaker_dependency_format" CHECK ("dependency_breaker"."dependency" ~ '^[a-z0-9]+([_.:-][a-z0-9]+)*$'),
	CONSTRAINT "dependency_breaker_status_valid" CHECK ("dependency_breaker"."status" in ('closed', 'open', 'half_open')),
	CONSTRAINT "dependency_breaker_retry_at_matches_status" CHECK (("dependency_breaker"."status" = 'closed') = ("dependency_breaker"."retry_at" is null)),
	CONSTRAINT "dependency_breaker_counts_nonnegative" CHECK ("dependency_breaker"."consecutive_failures" >= 0 and "dependency_breaker"."opens" >= 0),
	CONSTRAINT "dependency_breaker_last_error_name" CHECK ("dependency_breaker"."last_error" is null or "dependency_breaker"."last_error" ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$')
);
--> statement-breakpoint
CREATE TABLE "kill_switch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position" bigint GENERATED ALWAYS AS IDENTITY (sequence name "kill_switch_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"candidate_id" uuid NOT NULL,
	"subsystem" text NOT NULL,
	"enabled" boolean NOT NULL,
	"actor" text NOT NULL,
	"reason" text NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kill_switch_position_unique" UNIQUE("position"),
	CONSTRAINT "kill_switch_subsystem_valid" CHECK ("kill_switch"."subsystem" ~ '^(auto_apply|outreach_send|inbox_auto_label|(source|adapter|agent):[a-z0-9]+([_.-][a-z0-9]+)*)$'),
	CONSTRAINT "kill_switch_actor_valid" CHECK ("kill_switch"."actor" in ('user', 'system')),
	CONSTRAINT "kill_switch_reason_length" CHECK (length(trim("kill_switch"."reason")) between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "dependency_breaker" ADD CONSTRAINT "dependency_breaker_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kill_switch" ADD CONSTRAINT "kill_switch_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;
