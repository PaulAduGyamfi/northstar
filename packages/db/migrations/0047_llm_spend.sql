CREATE TABLE "llm_spend" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"route" text NOT NULL,
	"cost_micro_usd" bigint NOT NULL,
	"spent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_spend_route_format" CHECK ("llm_spend"."route" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length("llm_spend"."route") <= 64),
	CONSTRAINT "llm_spend_cost_nonnegative" CHECK ("llm_spend"."cost_micro_usd" >= 0)
);
--> statement-breakpoint
ALTER TABLE "llm_spend" ADD CONSTRAINT "llm_spend_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;
