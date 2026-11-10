CREATE TABLE "mfa_recovery_code_sets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mfa_recovery_code_sets_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "mfa_recovery_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"set_id" uuid NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mfa_recovery_codes_set_hash_key" UNIQUE("set_id","code_hash"),
	CONSTRAINT "mfa_recovery_codes_set_id_mfa_recovery_code_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."mfa_recovery_code_sets"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
-- Recovery code tables are global identity tables (PRD §6 B), like mfa_factors:
-- the API reads them in the login path before a tenant context exists, so they
-- have no RLS. The code itself is never stored, only its keyed blind index.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mfa_recovery_code_sets TO legend_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mfa_recovery_codes TO legend_app;
