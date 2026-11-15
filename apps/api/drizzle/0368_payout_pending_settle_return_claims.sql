-- legend-w3691: a return proof (evidence key) is claimed by exactly one return
-- operation (its item set), consumed atomically with the return itself.
-- legend-2aspe: payout GL posting kind `settle_pending` (settlement waiting
-- for the payroll.locked journal), resolved when that journal posts.
CREATE TABLE "payroll_payout_return_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"evidence_key" varchar(500) NOT NULL,
	"item_set_hash" varchar(64) NOT NULL,
	"status" varchar(8) DEFAULT 'open' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "payroll_payout_return_claims_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payroll_payout_return_claims_tenant_batch_id_key" UNIQUE("tenant_id","batch_id","id"),
	CONSTRAINT "payroll_payout_return_claims_evidence_key" UNIQUE("tenant_id","evidence_key"),
	CONSTRAINT "payroll_payout_return_claims_status_check" CHECK ("payroll_payout_return_claims"."status" IN ('open', 'consumed')),
	CONSTRAINT "payroll_payout_return_claims_hash_check" CHECK ("payroll_payout_return_claims"."item_set_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "payroll_payout_return_claims_consumed_check" CHECK (("payroll_payout_return_claims"."status" = 'open' AND "payroll_payout_return_claims"."consumed_at" IS NULL) OR ("payroll_payout_return_claims"."status" = 'consumed' AND "payroll_payout_return_claims"."consumed_at" IS NOT NULL)),
	CONSTRAINT "payroll_payout_return_claims_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_return_claims_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."payroll_disbursement_batches"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "payroll_payout_return_claims_tenant_batch_idx" ON "payroll_payout_return_claims" USING btree ("tenant_id","batch_id");--> statement-breakpoint
ALTER TABLE "payroll_disbursement_items" ADD COLUMN "return_claim_id" uuid;--> statement-breakpoint
-- Validating the new FK scans the existing items rows through the RLS policy,
-- which needs a tenant context a migration owner without BYPASSRLS does not have.
-- FORCE RLS is lifted for this one statement and restored, as in 0348.
ALTER TABLE "payroll_disbursement_items" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payroll_disbursement_items" ADD CONSTRAINT "payroll_disbursement_items_return_claim_fk" FOREIGN KEY ("tenant_id","batch_id","return_claim_id") REFERENCES "public"."payroll_payout_return_claims"("tenant_id","batch_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_disbursement_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payroll_payout_return_claims'::regclass);
--> statement-breakpoint
-- A claim is the record that a proof was used: never erased.
REVOKE DELETE, TRUNCATE ON TABLE public.payroll_payout_return_claims FROM legend_app;
--> statement-breakpoint
-- The only kind change a posting may ever make: settle_pending -> settle, once
-- the payroll.locked journal exists. Everything else stays frozen (as 0348/0350).
GRANT UPDATE (kind) ON TABLE public.payroll_payout_gl_postings TO legend_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_payout_gl_postings_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF current_setting('app.payroll_reseal', true) IS NOT DISTINCT FROM 'on'
    AND NEW.pii_key_version > OLD.pii_key_version
    AND NEW.total_encrypted IS DISTINCT FROM OLD.total_encrypted
    AND (to_jsonb(NEW) - 'total_encrypted' - 'pii_key_version')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'total_encrypted' - 'pii_key_version') THEN
    RETURN NEW;
  END IF;
  IF OLD.fee_posted = false AND NEW.fee_posted = true
    AND (to_jsonb(NEW) - 'fee_posted') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'fee_posted') THEN
    RETURN NEW;
  END IF;
  IF OLD.kind = 'settle_pending' AND NEW.kind = 'settle'
    AND (to_jsonb(NEW) - 'kind') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'kind') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PAYOUT-30: payout GL posting % cannot change', OLD.id
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
ALTER TABLE "payroll_payout_gl_postings" DROP CONSTRAINT "payroll_payout_gl_postings_kind_check";--> statement-breakpoint
ALTER TABLE "payroll_payout_gl_postings" ADD CONSTRAINT "payroll_payout_gl_postings_kind_check" CHECK ("payroll_payout_gl_postings"."kind" IN ('settle', 'settle_pending', 'settle_skipped', 'return', 'overpaid'));
--> statement-breakpoint
-- A claim moves only open -> consumed (consumed_at set); every other column and
-- every other change is refused, as for the GL postings (0348).
CREATE OR REPLACE FUNCTION app.payroll_payout_return_claims_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.status = 'open' AND NEW.status = 'consumed' AND NEW.consumed_at IS NOT NULL
    AND (to_jsonb(NEW) - 'status' - 'consumed_at')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'status' - 'consumed_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PAYOUT-31: return claim % cannot change', OLD.id
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payroll_payout_return_claims_guard_trg ON public.payroll_payout_return_claims;
--> statement-breakpoint
CREATE TRIGGER payroll_payout_return_claims_guard_trg
  BEFORE UPDATE ON public.payroll_payout_return_claims
  FOR EACH ROW EXECUTE FUNCTION app.payroll_payout_return_claims_guard();
