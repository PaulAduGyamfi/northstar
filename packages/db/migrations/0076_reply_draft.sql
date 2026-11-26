CREATE TABLE "reply_draft" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"request_kind" text DEFAULT 'email_reply' NOT NULL,
	"gmail_message_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"to_address" text NOT NULL,
	"subject" text NOT NULL,
	"in_reply_to" text NOT NULL,
	"references" jsonb NOT NULL,
	"body" text NOT NULL,
	"reply_to_other_domain" boolean NOT NULL,
	"cites" jsonb NOT NULL,
	"follow_ups" jsonb NOT NULL,
	"content_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reply_draft_request_unique" UNIQUE("request_id"),
	CONSTRAINT "reply_draft_request_kind" CHECK ("reply_draft"."request_kind" = 'email_reply'),
	CONSTRAINT "reply_draft_gmail_ids_shape" CHECK ("reply_draft"."gmail_message_id" ~ '^[0-9a-f]{8,32}$' and "reply_draft"."thread_id" ~ '^[0-9a-f]{8,32}$'),
	CONSTRAINT "reply_draft_sha256_shape" CHECK ("reply_draft"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "reply_draft_to_shape" CHECK (char_length("reply_draft"."to_address") between 3 and 254 and "reply_draft"."to_address" ~ '^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+$'),
	CONSTRAINT "reply_draft_headers_no_control" CHECK (char_length("reply_draft"."subject") between 1 and 300 and ("reply_draft"."subject" || "reply_draft"."in_reply_to") !~ '[[:cntrl:]]'),
	CONSTRAINT "reply_draft_body_shape" CHECK (char_length("reply_draft"."body") between 1 and 5000),
	CONSTRAINT "reply_draft_lists_shape" CHECK (jsonb_typeof("reply_draft"."references") = 'array' and jsonb_typeof("reply_draft"."cites") = 'array' and jsonb_typeof("reply_draft"."follow_ups") = 'array')
);
--> statement-breakpoint
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_id_kind_content_unique" UNIQUE("id","candidate_id","kind","content_sha256");--> statement-breakpoint
ALTER TABLE "reply_draft" ADD CONSTRAINT "reply_draft_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_draft" ADD CONSTRAINT "reply_draft_request_same_candidate_fk" FOREIGN KEY ("request_id","candidate_id","request_kind","content_sha256") REFERENCES "public"."approval_request"("id","candidate_id","kind","content_sha256") ON DELETE no action ON UPDATE no action;
