CREATE TABLE "answer_draft" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"request_kind" text DEFAULT 'answer' NOT NULL,
	"answer_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"field_name" text NOT NULL,
	"canonical_id" text NOT NULL,
	"kind" text NOT NULL,
	"short_text" text NOT NULL,
	"long_text" text,
	"confidence" real NOT NULL,
	"story_ids" jsonb NOT NULL,
	"atom_ids" jsonb NOT NULL,
	"content_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "answer_draft_request_unique" UNIQUE("request_id"),
	CONSTRAINT "answer_draft_answer_unique" UNIQUE("candidate_id","answer_id"),
	CONSTRAINT "answer_draft_request_kind" CHECK ("answer_draft"."request_kind" = 'answer'),
	CONSTRAINT "answer_draft_kind" CHECK ("answer_draft"."kind" in ('reusable_narrative', 'company_specific')),
	CONSTRAINT "answer_draft_canonical_shape" CHECK ("answer_draft"."canonical_id" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "answer_draft_field_shape" CHECK (char_length("answer_draft"."field_name") between 1 and 200 and "answer_draft"."field_name" !~ '[[:cntrl:]]'),
	CONSTRAINT "answer_draft_confidence_range" CHECK ("answer_draft"."confidence" between 0 and 1),
	CONSTRAINT "answer_draft_sha256_shape" CHECK ("answer_draft"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "answer_draft_text_shape" CHECK (char_length("answer_draft"."short_text") between 1 and 5000 and ("answer_draft"."long_text" is null or char_length("answer_draft"."long_text") between 1 and 10000)),
	CONSTRAINT "answer_draft_lists_shape" CHECK (jsonb_typeof("answer_draft"."story_ids") = 'array' and jsonb_typeof("answer_draft"."atom_ids") = 'array')
);
--> statement-breakpoint
ALTER TABLE "answer_draft" ADD CONSTRAINT "answer_draft_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_draft" ADD CONSTRAINT "answer_draft_request_same_candidate_fk" FOREIGN KEY ("request_id","candidate_id","request_kind","content_sha256") REFERENCES "public"."approval_request"("id","candidate_id","kind","content_sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_draft" ADD CONSTRAINT "answer_draft_application_same_candidate_fk" FOREIGN KEY ("application_id","candidate_id") REFERENCES "public"."application"("id","candidate_id") ON DELETE no action ON UPDATE no action;
