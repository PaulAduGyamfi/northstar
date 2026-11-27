CREATE TABLE "approval_edit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"previous_request_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"edited_at" timestamp with time zone NOT NULL,
	CONSTRAINT "approval_edit_one_per_previous" UNIQUE("previous_request_id"),
	CONSTRAINT "approval_edit_one_per_request" UNIQUE("request_id"),
	CONSTRAINT "approval_edit_not_itself" CHECK ("approval_edit"."previous_request_id" <> "approval_edit"."request_id")
);
--> statement-breakpoint
ALTER TABLE "approval_edit" ADD CONSTRAINT "approval_edit_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_edit" ADD CONSTRAINT "approval_edit_previous_same_candidate_fk" FOREIGN KEY ("previous_request_id","candidate_id") REFERENCES "public"."approval_request"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_edit" ADD CONSTRAINT "approval_edit_request_same_candidate_fk" FOREIGN KEY ("request_id","candidate_id") REFERENCES "public"."approval_request"("id","candidate_id") ON DELETE no action ON UPDATE no action;
