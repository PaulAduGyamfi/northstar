CREATE TABLE "interview_decision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"detection_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interview_decision_once" UNIQUE("detection_id"),
	CONSTRAINT "interview_decision_valid" CHECK ("interview_decision"."decision" in ('confirmed', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE "interview_detection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"calendar_event_id" text NOT NULL,
	"format" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"interviewer_count" integer NOT NULL,
	"version" integer NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interview_detection_version_once" UNIQUE("candidate_id","calendar_event_id","application_id","version"),
	CONSTRAINT "interview_detection_version_range" CHECK ("interview_detection"."version" between 1 and 10),
	CONSTRAINT "interview_detection_event_id_shape" CHECK ("interview_detection"."calendar_event_id" ~ '^[A-Za-z0-9_]{1,200}$'),
	CONSTRAINT "interview_detection_format_listed" CHECK ("interview_detection"."format" in ('phone_screen', 'technical', 'system_design', 'behavioral', 'onsite', 'other')),
	CONSTRAINT "interview_detection_ends_after_start" CHECK ("interview_detection"."ends_at" > "interview_detection"."starts_at"),
	CONSTRAINT "interview_detection_interviewers_range" CHECK ("interview_detection"."interviewer_count" between 0 and 50)
);
--> statement-breakpoint
ALTER TABLE "interview_decision" ADD CONSTRAINT "interview_decision_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_detection" ADD CONSTRAINT "interview_detection_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_detection" ADD CONSTRAINT "interview_detection_application_same_candidate_fk" FOREIGN KEY ("application_id","candidate_id") REFERENCES "public"."application"("id","candidate_id") ON DELETE no action ON UPDATE no action;
