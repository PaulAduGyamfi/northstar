CREATE TABLE "vault_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"secret_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"purpose" text NOT NULL,
	"decision_id" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vault_access_actor_valid" CHECK ("vault_access"."actor" ~ '^agent:[a-z0-9-]+$'),
	CONSTRAINT "vault_access_purpose_valid" CHECK ("vault_access"."purpose" ~ '^[a-z]+(_[a-z]+)*$')
);
--> statement-breakpoint
CREATE TABLE "vault_secret" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"tenant_key" text NOT NULL,
	"version" integer NOT NULL,
	"master_key_id" text NOT NULL,
	"wrapped_key_iv" "bytea" NOT NULL,
	"wrapped_key" "bytea" NOT NULL,
	"wrapped_key_tag" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"tag" "bytea" NOT NULL,
	"stored_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vault_secret_version_unique" UNIQUE("candidate_id","tenant_key","version"),
	CONSTRAINT "vault_secret_id_candidate_unique" UNIQUE("id","candidate_id"),
	CONSTRAINT "vault_secret_tenant_key_valid" CHECK ("vault_secret"."tenant_key" ~ '^[a-z0-9]+:[a-z0-9]+([_.-][a-z0-9]+)*$'),
	CONSTRAINT "vault_secret_master_key_id_valid" CHECK ("vault_secret"."master_key_id" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "vault_secret_version_positive" CHECK ("vault_secret"."version" >= 1),
	CONSTRAINT "vault_secret_sizes" CHECK (octet_length("vault_secret"."wrapped_key_iv") = 12 and octet_length("vault_secret"."iv") = 12
        and octet_length("vault_secret"."wrapped_key_tag") = 16 and octet_length("vault_secret"."tag") = 16
        and octet_length("vault_secret"."wrapped_key") = 32 and octet_length("vault_secret"."ciphertext") >= 1)
);
--> statement-breakpoint
ALTER TABLE "kill_switch" DROP CONSTRAINT "kill_switch_subsystem_valid";--> statement-breakpoint
ALTER TABLE "vault_access" ADD CONSTRAINT "vault_access_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_access" ADD CONSTRAINT "vault_access_secret_same_candidate_fk" FOREIGN KEY ("secret_id","candidate_id") REFERENCES "public"."vault_secret"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_access" ADD CONSTRAINT "vault_access_decision_same_candidate_fk" FOREIGN KEY ("decision_id","candidate_id") REFERENCES "public"."approval_decision"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_secret" ADD CONSTRAINT "vault_secret_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kill_switch" ADD CONSTRAINT "kill_switch_subsystem_valid" CHECK ("kill_switch"."subsystem" ~ '^(auto_apply|outreach_send|inbox_auto_label|vault|(source|adapter|agent):[a-z0-9]+([_.-][a-z0-9]+)*)$');