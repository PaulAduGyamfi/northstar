CREATE TABLE "profile_contact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position" bigint GENERATED ALWAYS AS IDENTITY (sequence name "profile_contact_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"candidate_id" uuid NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_contact_position_unique" UNIQUE("position"),
	CONSTRAINT "profile_contact_first_name_shape" CHECK (char_length("profile_contact"."first_name") BETWEEN 1 AND 100),
	CONSTRAINT "profile_contact_last_name_shape" CHECK (char_length("profile_contact"."last_name") BETWEEN 1 AND 100),
	CONSTRAINT "profile_contact_email_shape" CHECK (char_length("profile_contact"."email") BETWEEN 3 AND 254 AND "profile_contact"."email" LIKE '%_@_%'),
	CONSTRAINT "profile_contact_phone_shape" CHECK ("profile_contact"."phone" IS NULL OR char_length("profile_contact"."phone") BETWEEN 1 AND 40),
	CONSTRAINT "profile_contact_no_control_chars" CHECK (("profile_contact"."first_name" || "profile_contact"."last_name" || "profile_contact"."email" || coalesce("profile_contact"."phone", '')) !~ '[[:cntrl:]]')
);
--> statement-breakpoint
ALTER TABLE "profile_contact" ADD CONSTRAINT "profile_contact_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;
