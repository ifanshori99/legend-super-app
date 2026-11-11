-- legend-jemg: staff passkey (WebAuthn) MFA. Additive: one NOT NULL column with
-- a constant default on mfa_factors (the credential id and public key live in
-- the existing public_key jsonb) and one new empty table. No data statement.
ALTER TABLE "mfa_factors" ADD COLUMN "sign_count" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE "mfa_passkey_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"factor_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"purpose" varchar(12) NOT NULL,
	"challenge" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mfa_passkey_challenges_factor_session_purpose_key" UNIQUE("factor_id","session_id","purpose"),
	CONSTRAINT "mfa_passkey_challenges_purpose_check" CHECK ("mfa_passkey_challenges"."purpose" IN ('register', 'authenticate')),
	CONSTRAINT "mfa_passkey_challenges_factor_id_mfa_factors_id_fk" FOREIGN KEY ("factor_id") REFERENCES "public"."mfa_factors"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "mfa_passkey_challenges_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
-- Global identity table (PRD §6 B), like mfa_factors: the verify path runs before
-- a tenant context is relevant, so there is no RLS. Rows are scoped in SQL by the
-- factor's owner and the caller's session.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mfa_passkey_challenges TO legend_app;
