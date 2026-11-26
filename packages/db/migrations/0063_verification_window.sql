CREATE TABLE "verification_used_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"gmail_message_id" text NOT NULL,
	"window_id" uuid NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_used_message_once" UNIQUE("candidate_id","gmail_message_id"),
	CONSTRAINT "verification_used_message_id_shape" CHECK ("verification_used_message"."gmail_message_id" ~ '^[A-Za-z0-9_-]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "verification_window" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"tenant" text NOT NULL,
	"ats" text NOT NULL,
	"purpose" text NOT NULL,
	"sender_domains" text[] NOT NULL,
	"link_hosts" text[] NOT NULL,
	"ttl_ms" integer NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_window_id_candidate_unique" UNIQUE("id","candidate_id"),
	CONSTRAINT "verification_window_tenant_shape" CHECK ("verification_window"."tenant" ~ '^[A-Za-z0-9][A-Za-z0-9 .&''-]{0,63}$'),
	CONSTRAINT "verification_window_ats_shape" CHECK ("verification_window"."ats" ~ '^[A-Za-z0-9][A-Za-z0-9 .&''-]{0,63}$'),
	CONSTRAINT "verification_window_purpose_valid" CHECK ("verification_window"."purpose" in ('sign_up', 'sign_in', 'submit', 'password_reset')),
	CONSTRAINT "verification_window_senders_shape" CHECK (cardinality("verification_window"."sender_domains") between 1 and 20 and array_to_string("verification_window"."sender_domains", ' ') ~ '^[a-z0-9-]+([.][a-z0-9-]+)+( [a-z0-9-]+([.][a-z0-9-]+)+)*$'),
	CONSTRAINT "verification_window_hosts_shape" CHECK (cardinality("verification_window"."link_hosts") <= 20 and (cardinality("verification_window"."link_hosts") = 0 or array_to_string("verification_window"."link_hosts", ' ') ~ '^[a-z0-9-]+([.][a-z0-9-]+)+( [a-z0-9-]+([.][a-z0-9-]+)+)*$')),
	CONSTRAINT "verification_window_ttl_range" CHECK ("verification_window"."ttl_ms" between 1 and 1800000),
	CONSTRAINT "verification_window_expiry_after_open" CHECK ("verification_window"."expires_at" > "verification_window"."opened_at")
);
--> statement-breakpoint
CREATE TABLE "verification_window_close" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"window_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"closed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "verification_window_close_once" UNIQUE("window_id"),
	CONSTRAINT "verification_window_close_reason_valid" CHECK ("verification_window_close"."reason" in ('verified', 'link_host_not_allowed', 'ambiguous_content', 'message_too_large', 'no_email'))
);
--> statement-breakpoint
CREATE TABLE "verification_window_restart" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"window_id" uuid NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "verification_window_restart_once" UNIQUE("window_id"),
	CONSTRAINT "verification_window_restart_expiry_after_open" CHECK ("verification_window_restart"."expires_at" > "verification_window_restart"."opened_at")
);
--> statement-breakpoint
ALTER TABLE "verification_used_message" ADD CONSTRAINT "verification_used_message_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_used_message" ADD CONSTRAINT "verification_used_message_window_fk" FOREIGN KEY ("window_id","candidate_id") REFERENCES "public"."verification_window"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_window" ADD CONSTRAINT "verification_window_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_window_close" ADD CONSTRAINT "verification_window_close_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_window_close" ADD CONSTRAINT "verification_window_close_window_fk" FOREIGN KEY ("window_id","candidate_id") REFERENCES "public"."verification_window"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_window_restart" ADD CONSTRAINT "verification_window_restart_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_window_restart" ADD CONSTRAINT "verification_window_restart_window_fk" FOREIGN KEY ("window_id","candidate_id") REFERENCES "public"."verification_window"("id","candidate_id") ON DELETE no action ON UPDATE no action;