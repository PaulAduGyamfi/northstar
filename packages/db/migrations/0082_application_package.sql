CREATE TABLE "application_package" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"request_kind" text DEFAULT 'application_package' NOT NULL,
	"application_id" uuid NOT NULL,
	"content_sha256" text NOT NULL,
	"package" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_package_request_unique" UNIQUE("request_id"),
	CONSTRAINT "application_package_request_kind" CHECK ("application_package"."request_kind" = 'application_package'),
	CONSTRAINT "application_package_sha256_shape" CHECK ("application_package"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "application_package_is_object" CHECK (jsonb_typeof("application_package"."package") = 'object')
);
--> statement-breakpoint
ALTER TABLE "application_package" ADD CONSTRAINT "application_package_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_package" ADD CONSTRAINT "application_package_request_same_candidate_fk" FOREIGN KEY ("request_id","candidate_id","request_kind","content_sha256") REFERENCES "public"."approval_request"("id","candidate_id","kind","content_sha256") ON DELETE no action ON UPDATE no action;