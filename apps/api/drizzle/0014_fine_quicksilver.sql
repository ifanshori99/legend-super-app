CREATE TABLE "mfa_factors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"type" varchar(20) NOT NULL,
	"secret_encrypted" text,
	"public_key" jsonb,
	"verified_at" timestamp with time zone,
	"last_used_step" bigint,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "kind" varchar(20) DEFAULT 'customer' NOT NULL;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "device_label" varchar(120);--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "mfa_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "mfa_factors_user_id_idx" ON "mfa_factors" USING btree ("user_id");--> statement-breakpoint
-- mfa_factors is a global identity table (PRD §6 B), like "user"/"session": the
-- API login path reads it before a tenant context exists, so it has no RLS.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mfa_factors TO legend_app;
