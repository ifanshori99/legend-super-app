ALTER TABLE "tenant_domains" ADD COLUMN "verification_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_domains" ADD COLUMN "verification_window_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_domains" ADD CONSTRAINT "tenant_domains_verification_attempts_check" CHECK ("tenant_domains"."verification_attempts" BETWEEN 0 AND 5);