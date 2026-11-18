CREATE TABLE "payroll_payout_recon_clearances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"exception_id" uuid NOT NULL,
	"reason" varchar(500) NOT NULL,
	"proposed_by" text NOT NULL,
	"proposed_session_id" text NOT NULL,
	"proposed_grant_id" uuid NOT NULL,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" text,
	"approved_session_id" text,
	"approved_grant_id" uuid,
	"approved_at" timestamp with time zone,
	CONSTRAINT "payroll_payout_recon_clearances_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payroll_payout_recon_clearances_exception_key" UNIQUE("tenant_id","exception_id"),
	CONSTRAINT "payroll_payout_recon_clearances_reason_check" CHECK (char_length(btrim("payroll_payout_recon_clearances"."reason")) >= 10),
	CONSTRAINT "payroll_payout_recon_clearances_approved_check" CHECK (("payroll_payout_recon_clearances"."approved_by" IS NULL AND "payroll_payout_recon_clearances"."approved_session_id" IS NULL AND "payroll_payout_recon_clearances"."approved_grant_id" IS NULL AND "payroll_payout_recon_clearances"."approved_at" IS NULL) OR ("payroll_payout_recon_clearances"."approved_by" IS NOT NULL AND "payroll_payout_recon_clearances"."approved_session_id" IS NOT NULL AND "payroll_payout_recon_clearances"."approved_grant_id" IS NOT NULL AND "payroll_payout_recon_clearances"."approved_at" IS NOT NULL AND "payroll_payout_recon_clearances"."approved_by" <> "payroll_payout_recon_clearances"."proposed_by")),
	CONSTRAINT "payroll_payout_recon_clearances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_recon_clearances_exception_fk" FOREIGN KEY ("tenant_id","exception_id") REFERENCES "public"."payroll_payout_recon_exceptions"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_recon_clearances_proposed_grant_fk" FOREIGN KEY ("tenant_id","proposed_grant_id") REFERENCES "public"."payroll_payout_grants"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_recon_clearances_approved_grant_fk" FOREIGN KEY ("tenant_id","approved_grant_id") REFERENCES "public"."payroll_payout_grants"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "payroll_payout_grants" DROP CONSTRAINT "payroll_payout_grants_kind_check";--> statement-breakpoint
ALTER TABLE "payroll_payout_grants" DROP CONSTRAINT "payroll_payout_grants_detail_check";--> statement-breakpoint
ALTER TABLE "payroll_disbursement_items" ADD COLUMN "return_bank_ref" varchar(64);--> statement-breakpoint
ALTER TABLE "payroll_payout_return_claims" ADD COLUMN "bank_ref" varchar(64);--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_payout_return_claims_bank_ref_key" ON "payroll_payout_return_claims" USING btree ("tenant_id","bank_ref") WHERE "payroll_payout_return_claims"."bank_ref" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_payout_grants" ADD CONSTRAINT "payroll_payout_grants_kind_check" CHECK ("payroll_payout_grants"."kind" IN ('correction', 'overpaid', 'return', 'posting_source', 'closure', 'resolve', 'bank_confirm', 'batch_approve', 'disown', 'unfreeze', 'recon_clear'));--> statement-breakpoint
ALTER TABLE "payroll_payout_grants" ADD CONSTRAINT "payroll_payout_grants_detail_check" CHECK (("payroll_payout_grants"."kind" = 'resolve' AND "payroll_payout_grants"."detail" IN ('failed', 'not_sent')) OR ("payroll_payout_grants"."kind" = 'bank_confirm' AND "payroll_payout_grants"."detail" = 'succeeded') OR ("payroll_payout_grants"."kind" IN ('disown', 'unfreeze', 'recon_clear') AND "payroll_payout_grants"."detail" ~ '^[0-9a-f]{64}$') OR ("payroll_payout_grants"."kind" NOT IN ('resolve', 'bank_confirm', 'disown', 'unfreeze', 'recon_clear') AND "payroll_payout_grants"."detail" IS NULL));
--> statement-breakpoint
-- legend-xbagc (990): clearance of a reconciliation flag. Two finance people
-- (propose, approve), each under a one-time payout grant (kind recon_clear,
-- password step-up). Owner: the migrator. Written only by the trusted functions
-- of legend_payout (app.payout_recon_clear_propose / _approve, 0461); legend_app
-- may only read. Pattern of payroll_payout_proof_closures (0410).
SELECT app.enforce_tenant_rls('public.payroll_payout_recon_clearances'::regclass);
--> statement-breakpoint
-- enforce_tenant_rls hands legend_app full DML; this table is the opposite.
REVOKE ALL ON TABLE public.payroll_payout_recon_clearances FROM PUBLIC, legend_app;
--> statement-breakpoint
GRANT SELECT ON TABLE public.payroll_payout_recon_clearances TO legend_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.payroll_payout_recon_clearances TO legend_payout;
--> statement-breakpoint
GRANT UPDATE (approved_by, approved_session_id, approved_grant_id, approved_at)
  ON TABLE public.payroll_payout_recon_clearances TO legend_payout;
--> statement-breakpoint
-- A clearance moves once: the approve step fills approved_by, approved_session_id,
-- approved_grant_id and approved_at from NULL (the CHECK says the approver is not
-- the proposer); every other column stays, and a row is never deleted
-- (PAYOUT-87, 23514).
CREATE FUNCTION app.payroll_payout_recon_clearances_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD.approved_at IS NULL AND NEW.approved_at IS NOT NULL
    AND (to_jsonb(NEW) - 'approved_by' - 'approved_session_id' - 'approved_grant_id' - 'approved_at')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'approved_by' - 'approved_session_id' - 'approved_grant_id' - 'approved_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PAYOUT-87: a reconciliation clearance cannot be changed or erased once approved'
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER payroll_payout_recon_clearances_row_guard_trg
  BEFORE UPDATE OR DELETE ON public.payroll_payout_recon_clearances
  FOR EACH ROW EXECUTE FUNCTION app.payroll_payout_recon_clearances_guard();
--> statement-breakpoint
CREATE TRIGGER payroll_payout_recon_clearances_truncate_guard_trg
  BEFORE TRUNCATE ON public.payroll_payout_recon_clearances
  FOR EACH STATEMENT EXECUTE FUNCTION app.payroll_payout_recon_clearances_guard();
