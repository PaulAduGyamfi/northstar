ALTER TABLE "certification" DROP CONSTRAINT "certification_issued_month_format";--> statement-breakpoint
ALTER TABLE "education" DROP CONSTRAINT "education_start_month_format";--> statement-breakpoint
ALTER TABLE "education" DROP CONSTRAINT "education_end_month_format";--> statement-breakpoint
ALTER TABLE "experience_atom" DROP CONSTRAINT "experience_atom_start_month_format";--> statement-breakpoint
ALTER TABLE "experience_atom" DROP CONSTRAINT "experience_atom_end_month_format";--> statement-breakpoint
ALTER TABLE "role" DROP CONSTRAINT "role_start_month_format";--> statement-breakpoint
ALTER TABLE "role" DROP CONSTRAINT "role_end_month_format";--> statement-breakpoint
ALTER TABLE "role" ADD COLUMN "is_current" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "certification" ADD CONSTRAINT "certification_issued_month_format" CHECK ("certification"."issued_month" is null or "certification"."issued_month" ~ '^[0-9]{4}(-(0[1-9]|1[0-2]))?$');--> statement-breakpoint
ALTER TABLE "education" ADD CONSTRAINT "education_start_month_format" CHECK ("education"."start_month" is null or "education"."start_month" ~ '^[0-9]{4}(-(0[1-9]|1[0-2]))?$');--> statement-breakpoint
ALTER TABLE "education" ADD CONSTRAINT "education_end_month_format" CHECK ("education"."end_month" is null or "education"."end_month" ~ '^[0-9]{4}(-(0[1-9]|1[0-2]))?$');--> statement-breakpoint
ALTER TABLE "experience_atom" ADD CONSTRAINT "experience_atom_start_month_format" CHECK ("experience_atom"."start_month" is null or "experience_atom"."start_month" ~ '^[0-9]{4}(-(0[1-9]|1[0-2]))?$');--> statement-breakpoint
ALTER TABLE "experience_atom" ADD CONSTRAINT "experience_atom_end_month_format" CHECK ("experience_atom"."end_month" is null or "experience_atom"."end_month" ~ '^[0-9]{4}(-(0[1-9]|1[0-2]))?$');--> statement-breakpoint
ALTER TABLE "role" ADD CONSTRAINT "role_start_month_format" CHECK ("role"."start_month" is null or "role"."start_month" ~ '^[0-9]{4}(-(0[1-9]|1[0-2]))?$');--> statement-breakpoint
ALTER TABLE "role" ADD CONSTRAINT "role_end_month_format" CHECK ("role"."end_month" is null or "role"."end_month" ~ '^[0-9]{4}(-(0[1-9]|1[0-2]))?$');
