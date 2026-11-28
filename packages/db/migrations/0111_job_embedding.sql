CREATE TABLE "job_duplicate_suggestion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position" bigint GENERATED ALWAYS AS IDENTITY (sequence name "job_duplicate_suggestion_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"candidate_id" uuid NOT NULL,
	"job_a" uuid NOT NULL,
	"job_b" uuid NOT NULL,
	"model" text NOT NULL,
	"similarity" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_duplicate_suggestion_position_unique" UNIQUE("position"),
	CONSTRAINT "job_duplicate_suggestion_pair_unique" UNIQUE("candidate_id","job_a","job_b","model"),
	CONSTRAINT "job_duplicate_suggestion_pair_ordered" CHECK ("job_duplicate_suggestion"."job_a" < "job_duplicate_suggestion"."job_b"),
	CONSTRAINT "job_duplicate_suggestion_model_valid" CHECK ("job_duplicate_suggestion"."model" = 'text-embedding-3-small'),
	CONSTRAINT "job_duplicate_suggestion_similarity_range" CHECK ("job_duplicate_suggestion"."similarity" >= 0 AND "job_duplicate_suggestion"."similarity" <= 1)
);
--> statement-breakpoint
CREATE TABLE "job_embedding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position" bigint GENERATED ALWAYS AS IDENTITY (sequence name "job_embedding_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"candidate_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"text_sha256" text NOT NULL,
	"embedding" vector(512) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_embedding_position_unique" UNIQUE("position"),
	CONSTRAINT "job_embedding_job_model_text_unique" UNIQUE("job_id","model","text_sha256"),
	CONSTRAINT "job_embedding_model_valid" CHECK ("job_embedding"."model" = 'text-embedding-3-small'),
	CONSTRAINT "job_embedding_dimensions_valid" CHECK ("job_embedding"."dimensions" = 512),
	CONSTRAINT "job_embedding_text_sha256_shape" CHECK ("job_embedding"."text_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "job_duplicate_suggestion" ADD CONSTRAINT "job_duplicate_suggestion_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_duplicate_suggestion" ADD CONSTRAINT "job_duplicate_suggestion_job_a_same_candidate_fk" FOREIGN KEY ("job_a","candidate_id") REFERENCES "public"."job"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_duplicate_suggestion" ADD CONSTRAINT "job_duplicate_suggestion_job_b_same_candidate_fk" FOREIGN KEY ("job_b","candidate_id") REFERENCES "public"."job"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_embedding" ADD CONSTRAINT "job_embedding_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_embedding" ADD CONSTRAINT "job_embedding_job_same_candidate_fk" FOREIGN KEY ("job_id","candidate_id") REFERENCES "public"."job"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_embedding_job_model_position_idx" ON "job_embedding" USING btree ("candidate_id","job_id","model","position");
--> statement-breakpoint
-- Job embeddings and duplicate suggestions are append-only (NS-129 slice 2, ADR-0012, ADR-0033):
-- a new text is a new row and a suggestion is never edited. Reuses the Approval Gate's reject
-- function (migration 0016), then grants the app role by the NS-212 rule (migration 0065).
CREATE TRIGGER job_embedding_no_update_or_delete
  BEFORE UPDATE OR DELETE ON job_embedding
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER job_embedding_no_truncate
  BEFORE TRUNCATE ON job_embedding
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER job_duplicate_suggestion_no_update_or_delete
  BEFORE UPDATE OR DELETE ON job_duplicate_suggestion
  FOR EACH ROW EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
CREATE TRIGGER job_duplicate_suggestion_no_truncate
  BEFORE TRUNCATE ON job_duplicate_suggestion
  FOR EACH STATEMENT EXECUTE FUNCTION approval_reject_change();
--> statement-breakpoint
SELECT northstar_grant_app_role();
