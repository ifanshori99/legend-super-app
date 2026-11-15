-- legend-w3691 (F2): every stored payout proof gets a SHA-256 fingerprint of its
-- content at upload; a return claim carries it, and one file content is claimed
-- by ONE return operation per tenant (a re-upload gets a new evidence key, but
-- the same fingerprint). Foreign keys of the new table are inline while it is
-- empty.
-- legend-cnpap (F3): a pending cash settlement freezes the cash source GL
-- account on its posting row.
CREATE TABLE "payroll_payout_evidence_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"evidence_key" varchar(500) NOT NULL,
	"content_sha256" varchar(64) NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_payout_evidence_files_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payroll_payout_evidence_files_evidence_key" UNIQUE("tenant_id","evidence_key"),
	CONSTRAINT "payroll_payout_evidence_files_sha_check" CHECK ("payroll_payout_evidence_files"."content_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "payroll_payout_evidence_files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_evidence_files_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."payroll_disbursement_batches"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "payroll_payout_evidence_files_tenant_sha_idx" ON "payroll_payout_evidence_files" USING btree ("tenant_id","content_sha256");--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payroll_payout_evidence_files'::regclass);
--> statement-breakpoint
-- A fingerprint is the record of what was uploaded: written once, never changed
-- or erased.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.payroll_payout_evidence_files FROM legend_app;
--> statement-breakpoint
ALTER TABLE "payroll_payout_return_claims" ADD COLUMN "content_sha256" varchar(64);--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_payout_return_claims_content_sha_key" ON "payroll_payout_return_claims" USING btree ("tenant_id","content_sha256") WHERE "payroll_payout_return_claims"."content_sha256" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_payout_return_claims" ADD CONSTRAINT "payroll_payout_return_claims_sha_check" CHECK ("payroll_payout_return_claims"."content_sha256" IS NULL OR "payroll_payout_return_claims"."content_sha256" ~ '^[a-f0-9]{64}$');--> statement-breakpoint
ALTER TABLE "payroll_payout_gl_postings" ADD COLUMN "source_gl_account_id" uuid;--> statement-breakpoint
-- Validating the new FK scans the existing postings rows through the RLS policy,
-- which needs a tenant context a migration owner without BYPASSRLS does not have.
-- FORCE RLS is lifted for this one statement and restored, as in 0348 and 0381.
ALTER TABLE "payroll_payout_gl_postings" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payroll_payout_gl_postings" ADD CONSTRAINT "payroll_payout_gl_postings_source_account_fk" FOREIGN KEY ("tenant_id","source_gl_account_id") REFERENCES "public"."chart_of_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_payout_gl_postings" FORCE ROW LEVEL SECURITY;
