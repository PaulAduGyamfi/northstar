CREATE TABLE "mail_poll_cursor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position" bigint GENERATED ALWAYS AS IDENTITY (sequence name "mail_poll_cursor_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"candidate_id" uuid NOT NULL,
	"since" timestamp with time zone NOT NULL,
	"overlap" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_poll_cursor_position_unique" UNIQUE("position")
);
--> statement-breakpoint
ALTER TABLE "mail_poll_cursor" ADD CONSTRAINT "mail_poll_cursor_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The mail poll's cursor is append-only (NS-247, ADR-0012): a move is a new row, never an edit.
-- Reuses the Approval Gate's reject function (migration 0016), then grants the app role by the
-- NS-212 rule (migration 0065).
CREATE TRIGGER mail_poll_cursor_no_update_or_delete
  BEFORE UPDATE OR DELETE ON mail_poll_cursor
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER mail_poll_cursor_no_truncate
  BEFORE TRUNCATE ON mail_poll_cursor
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
SELECT northstar_grant_app_role();
