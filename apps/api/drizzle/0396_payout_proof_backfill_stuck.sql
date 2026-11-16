-- legend-so897 (second opinion 895-897), F4 and F3:
-- F4: a proof key the fingerprint job could not complete (object unreadable, or
-- its hash already held by another proof) gets one row here. Each failed
-- attempt pushes `next_attempt_at` back, so the job reaches the targets behind
-- it instead of retrying the same window forever; the gate still holds the
-- tenant while the target exists. Finance sees the list. Never erased.
-- F3 (database backstop): a NEW return claim must carry both proof hashes. A
-- trigger, not a CHECK NOT VALID: a CHECK would also fire on the open ->
-- consumed update of a historical claim without hashes.
CREATE TABLE "payroll_payout_proof_backfill_stuck" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"evidence_key" varchar(500) NOT NULL,
	"reason" varchar(16) NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "payroll_payout_proof_backfill_stuck_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payroll_payout_proof_backfill_stuck_evidence_key" UNIQUE("tenant_id","evidence_key"),
	CONSTRAINT "payroll_payout_proof_backfill_stuck_reason_check" CHECK ("payroll_payout_proof_backfill_stuck"."reason" IN ('unreadable', 'hash_conflict', 'legacy_duplicate')),
	CONSTRAINT "payroll_payout_proof_backfill_stuck_attempts_check" CHECK ("payroll_payout_proof_backfill_stuck"."attempts" >= 1),
	CONSTRAINT "payroll_payout_proof_backfill_stuck_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_proof_backfill_stuck_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."payroll_disbursement_batches"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "payroll_payout_proof_backfill_stuck_tenant_next_idx" ON "payroll_payout_proof_backfill_stuck" USING btree ("tenant_id","next_attempt_at");--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payroll_payout_proof_backfill_stuck'::regclass);
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.payroll_payout_proof_backfill_stuck FROM legend_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_payout_return_claims_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.content_sha256 IS NOT NULL AND NEW.stored_sha256 IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PAYOUT-31: return claim % needs both proof hashes', NEW.id
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payroll_payout_return_claims_insert_guard_trg ON public.payroll_payout_return_claims;
--> statement-breakpoint
CREATE TRIGGER payroll_payout_return_claims_insert_guard_trg
  BEFORE INSERT ON public.payroll_payout_return_claims
  FOR EACH ROW EXECUTE FUNCTION app.payroll_payout_return_claims_insert_guard();
