CREATE TABLE "mail_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"gmail_message_id" text NOT NULL,
	"gmail_thread_id" text NOT NULL,
	"application_id" uuid,
	"step" text,
	"queue_reason" text,
	"sender_verified" boolean NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_link_one_per_message" UNIQUE("candidate_id","gmail_message_id"),
	CONSTRAINT "mail_link_gmail_ids_shape" CHECK ("mail_link"."gmail_message_id" ~ '^[0-9a-f]{1,32}$' and "mail_link"."gmail_thread_id" ~ '^[0-9a-f]{1,32}$'),
	CONSTRAINT "mail_link_linked_or_queued" CHECK (("mail_link"."application_id" is not null and "mail_link"."step" in ('tag', 'thread', 'sender') and "mail_link"."queue_reason" is null)
        or ("mail_link"."application_id" is null and "mail_link"."step" is null and "mail_link"."sender_verified" = false
            and "mail_link"."queue_reason" in ('unknown_tag', 'ambiguous', 'no_match')))
);
--> statement-breakpoint
CREATE TABLE "mail_tag" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"tag" text NOT NULL,
	"application_id" uuid,
	"tenant_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_tag_tag_unique" UNIQUE("candidate_id","tag"),
	CONSTRAINT "mail_tag_tag_shape" CHECK ("mail_tag"."tag" ~ '^[a-z2-7]{6}$'),
	CONSTRAINT "mail_tag_one_target" CHECK (("mail_tag"."application_id" is null) <> ("mail_tag"."tenant_key" is null)),
	CONSTRAINT "mail_tag_tenant_key_shape" CHECK ("mail_tag"."tenant_key" is null or "mail_tag"."tenant_key" ~ '^[a-z0-9]+:[a-z0-9]+([_.-][a-z0-9]+)*$')
);
--> statement-breakpoint
ALTER TABLE "mail_link" ADD CONSTRAINT "mail_link_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_link" ADD CONSTRAINT "mail_link_application_same_candidate_fk" FOREIGN KEY ("application_id","candidate_id") REFERENCES "public"."application"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_tag" ADD CONSTRAINT "mail_tag_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_tag" ADD CONSTRAINT "mail_tag_application_same_candidate_fk" FOREIGN KEY ("application_id","candidate_id") REFERENCES "public"."application"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_tag_one_per_application" ON "mail_tag" USING btree ("candidate_id","application_id") WHERE "mail_tag"."application_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_tag_one_per_tenant" ON "mail_tag" USING btree ("candidate_id","tenant_key") WHERE "mail_tag"."tenant_key" is not null;
