CREATE TABLE "passkey_credential" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" "bytea" NOT NULL,
	"sign_count" bigint NOT NULL,
	"transports" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "passkey_credential_id_unique" UNIQUE("credential_id"),
	CONSTRAINT "passkey_credential_id_candidate_unique" UNIQUE("id","candidate_id"),
	CONSTRAINT "passkey_credential_id_shape" CHECK ("passkey_credential"."credential_id" ~ '^[A-Za-z0-9_-]+$' and char_length("passkey_credential"."credential_id") between 16 and 1366),
	CONSTRAINT "passkey_credential_sign_count_valid" CHECK ("passkey_credential"."sign_count" >= 0),
	CONSTRAINT "passkey_credential_public_key_size" CHECK (octet_length("passkey_credential"."public_key") between 1 and 2048)
);
--> statement-breakpoint
CREATE TABLE "passkey_use" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"passkey_id" uuid NOT NULL,
	"sign_count" bigint NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "passkey_use_sign_count_valid" CHECK ("passkey_use"."sign_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "passkey_credential" ADD CONSTRAINT "passkey_credential_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey_use" ADD CONSTRAINT "passkey_use_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey_use" ADD CONSTRAINT "passkey_use_passkey_same_candidate_fk" FOREIGN KEY ("passkey_id","candidate_id") REFERENCES "public"."passkey_credential"("id","candidate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "passkey_use_one_per_count" ON "passkey_use" USING btree ("passkey_id","sign_count") WHERE "passkey_use"."sign_count" > 0;
