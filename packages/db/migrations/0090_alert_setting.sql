CREATE TABLE "alert_setting" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position" bigint GENERATED ALWAYS AS IDENTITY (sequence name "alert_setting_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"candidate_id" uuid NOT NULL,
	"quiet_kind" text,
	"quiet_start" integer,
	"quiet_end" integer,
	"time_zone" text,
	"tier1_in_quiet_hours" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_setting_position_unique" UNIQUE("position"),
	CONSTRAINT "alert_setting_quiet_shape" CHECK (("alert_setting"."quiet_kind" IS NULL AND "alert_setting"."quiet_start" IS NULL AND "alert_setting"."quiet_end" IS NULL)
        OR ("alert_setting"."quiet_kind" IS NOT DISTINCT FROM 'off' AND "alert_setting"."quiet_start" IS NULL AND "alert_setting"."quiet_end" IS NULL)
        OR ("alert_setting"."quiet_kind" IS NOT DISTINCT FROM 'range' AND "alert_setting"."quiet_start" IS NOT NULL AND "alert_setting"."quiet_end" IS NOT NULL
            AND "alert_setting"."quiet_start" BETWEEN 0 AND 1439
            AND "alert_setting"."quiet_end" BETWEEN 0 AND 1439 AND "alert_setting"."quiet_start" <> "alert_setting"."quiet_end")),
	CONSTRAINT "alert_setting_time_zone_shape" CHECK ("alert_setting"."time_zone" IS NULL OR "alert_setting"."time_zone" ~ '^[A-Za-z][A-Za-z0-9_+/-]{0,63}$')
);
--> statement-breakpoint
ALTER TABLE "alert_setting" ADD CONSTRAINT "alert_setting_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;