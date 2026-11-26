CREATE TABLE "profile_setting" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position" bigint GENERATED ALWAYS AS IDENTITY (sequence name "profile_setting_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"candidate_id" uuid NOT NULL,
	"field" text NOT NULL,
	"qualifier" text DEFAULT '' NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_setting_position_unique" UNIQUE("position"),
	CONSTRAINT "profile_setting_field_valid" CHECK ("profile_setting"."field" in ('work_authorization', 'needs_sponsorship', 'years_of_experience', 'current_location', 'willing_to_relocate', 'work_arrangement', 'earliest_start_date', 'notice_period', 'salary_expectation', 'referral_source', 'previously_employed', 'linkedin_url', 'portfolio_url')),
	CONSTRAINT "profile_setting_qualifier_matches_field" CHECK (("profile_setting"."field" in ('years_of_experience', 'work_authorization', 'previously_employed')) = (length("profile_setting"."qualifier") > 0)),
	CONSTRAINT "profile_setting_qualifier_length" CHECK (length("profile_setting"."qualifier") <= 100),
	CONSTRAINT "profile_setting_value_length" CHECK (length("profile_setting"."value") between 1 and 300)
);
--> statement-breakpoint
ALTER TABLE "profile_setting" ADD CONSTRAINT "profile_setting_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;
