CREATE TABLE "stored_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stored_file_candidate_sha_unique" UNIQUE("candidate_id","sha256"),
	CONSTRAINT "stored_file_sha256_matches" CHECK ("stored_file"."sha256" = encode(sha256("stored_file"."bytes"), 'hex')),
	CONSTRAINT "stored_file_content_type" CHECK ("stored_file"."content_type" IN ('application/pdf')),
	CONSTRAINT "stored_file_size_matches" CHECK ("stored_file"."byte_size" = octet_length("stored_file"."bytes")),
	CONSTRAINT "stored_file_size_range" CHECK ("stored_file"."byte_size" BETWEEN 1 AND 5242880)
);
--> statement-breakpoint
ALTER TABLE "tailored_resume" ADD COLUMN "pdf_sha256" text;--> statement-breakpoint
ALTER TABLE "stored_file" ADD CONSTRAINT "stored_file_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tailored_resume" ADD CONSTRAINT "tailored_resume_pdf_same_candidate_fk" FOREIGN KEY ("candidate_id","pdf_sha256") REFERENCES "public"."stored_file"("candidate_id","sha256") ON DELETE no action ON UPDATE no action;
