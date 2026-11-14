-- Payout GL postings and two-person return (bead legend-658 card wnkep.5;
-- design docs/design/payroll-disbursement.md 4.6, 6 R9/R10, 7.8, 8). Foreign
-- keys of the new table are inline while it is empty (docs/plan/contracts.md,
-- pattern 1). The item -> posting link is added on the existing items table.
CREATE TABLE "payroll_payout_gl_postings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"kind" varchar(14) NOT NULL,
	"item_set_hash" varchar(64) NOT NULL,
	"journal_key" varchar(100) NOT NULL,
	"total_encrypted" "bytea" NOT NULL,
	"pii_key_version" smallint NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_payout_gl_postings_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payroll_payout_gl_postings_tenant_batch_id_key" UNIQUE("tenant_id","batch_id","id"),
	CONSTRAINT "payroll_payout_gl_postings_journal_key" UNIQUE("tenant_id","journal_key"),
	CONSTRAINT "payroll_payout_gl_postings_kind_check" CHECK ("payroll_payout_gl_postings"."kind" IN ('settle', 'settle_skipped', 'return', 'overpaid')),
	CONSTRAINT "payroll_payout_gl_postings_hash_check" CHECK ("payroll_payout_gl_postings"."item_set_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "payroll_payout_gl_postings_key_version_check" CHECK ("payroll_payout_gl_postings"."pii_key_version" >= 1),
	CONSTRAINT "payroll_payout_gl_postings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_gl_postings_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."payroll_disbursement_batches"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "payroll_disbursement_items" ADD COLUMN "returned_by" text;--> statement-breakpoint
ALTER TABLE "payroll_disbursement_items" ADD COLUMN "returned_by_2" text;--> statement-breakpoint
ALTER TABLE "payroll_disbursement_items" ADD COLUMN "return_evidence_key" varchar(500);--> statement-breakpoint
ALTER TABLE "payroll_disbursement_items" ADD COLUMN "return_note" varchar(500);--> statement-breakpoint
CREATE INDEX "payroll_payout_gl_postings_tenant_batch_idx" ON "payroll_payout_gl_postings" USING btree ("tenant_id","batch_id");--> statement-breakpoint
-- FK validation scans the existing items table. A plain migration owner
-- without tenant context must bypass its forced tenant policy for this DDL,
-- as in 0065. Keep the validated FK and restore FORCE in this transaction
-- before any later migration work or commit. Application RLS stays enabled.
ALTER TABLE public.payroll_disbursement_items NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "payroll_disbursement_items" ADD CONSTRAINT "payroll_disbursement_items_gl_posting_fk" FOREIGN KEY ("tenant_id","batch_id","gl_posting_id") REFERENCES "public"."payroll_payout_gl_postings"("tenant_id","batch_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE public.payroll_disbursement_items FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "payroll_disbursement_items" ADD CONSTRAINT "payroll_disbursement_items_returners_check" CHECK (("payroll_disbursement_items"."returned_by" IS NULL AND "payroll_disbursement_items"."returned_by_2" IS NULL AND "payroll_disbursement_items"."return_evidence_key" IS NULL AND "payroll_disbursement_items"."return_note" IS NULL) OR ("payroll_disbursement_items"."status" IN ('succeeded', 'returned') AND "payroll_disbursement_items"."returned_by" IS NOT NULL AND "payroll_disbursement_items"."return_evidence_key" IS NOT NULL AND "payroll_disbursement_items"."return_note" IS NOT NULL AND ("payroll_disbursement_items"."returned_by_2" IS NULL OR "payroll_disbursement_items"."returned_by_2" <> "payroll_disbursement_items"."returned_by")));--> statement-breakpoint
ALTER TABLE "payroll_disbursement_items" ADD CONSTRAINT "payroll_disbursement_items_returned_check" CHECK ("payroll_disbursement_items"."status" <> 'returned' OR "payroll_disbursement_items"."returned_by" IS NULL OR "payroll_disbursement_items"."returned_by_2" IS NOT NULL);--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payroll_payout_gl_postings'::regclass);
--> statement-breakpoint
-- A posting is the record of what the ledger was told: never erased.
REVOKE DELETE, TRUNCATE ON TABLE public.payroll_payout_gl_postings FROM legend_app;
--> statement-breakpoint
-- PAYR-KEY (as 0344): only the reseal job moves the sealed total.
GRANT UPDATE (total_encrypted, pii_key_version) ON TABLE public.payroll_payout_gl_postings TO legend_app;
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
  RAISE EXCEPTION 'PAYOUT-30: payout GL posting % cannot change', OLD.id
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payroll_payout_gl_postings_guard_trg ON public.payroll_payout_gl_postings;
--> statement-breakpoint
CREATE TRIGGER payroll_payout_gl_postings_guard_trg
  BEFORE UPDATE ON public.payroll_payout_gl_postings
  FOR EACH ROW EXECUTE FUNCTION app.payroll_payout_gl_postings_guard();
--> statement-breakpoint
-- Item guard, GL side: the posting link is set once and only on a succeeded
-- item; the return columns move only while the item is succeeded and never
-- once written; `succeeded -> returned` needs two different people, neither
-- the batch requester, plus evidence (design 7.8, same rule as H2) whenever a
-- return proposal was recorded.
CREATE OR REPLACE FUNCTION app.payroll_disbursement_items_payout_gl_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  batch_requester text;
BEGIN
  IF NEW.gl_posting_id IS DISTINCT FROM OLD.gl_posting_id THEN
    IF OLD.gl_posting_id IS NOT NULL OR NEW.gl_posting_id IS NULL OR NEW.status <> 'succeeded' THEN
      RAISE EXCEPTION 'PAYOUT-31: the GL posting of item % is set once, on a succeeded item', OLD.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.returned_by IS DISTINCT FROM OLD.returned_by
    OR NEW.returned_by_2 IS DISTINCT FROM OLD.returned_by_2
    OR NEW.return_evidence_key IS DISTINCT FROM OLD.return_evidence_key
    OR NEW.return_note IS DISTINCT FROM OLD.return_note THEN
    IF OLD.status <> 'succeeded' THEN
      RAISE EXCEPTION 'PAYOUT-32: item % can be returned only while succeeded (is %)', OLD.id, OLD.status
        USING ERRCODE = '23514';
    END IF;
    IF (OLD.returned_by IS NOT NULL AND (
           NEW.returned_by IS DISTINCT FROM OLD.returned_by
        OR NEW.return_evidence_key IS DISTINCT FROM OLD.return_evidence_key
        OR NEW.return_note IS DISTINCT FROM OLD.return_note))
      OR (OLD.returned_by_2 IS NOT NULL AND NEW.returned_by_2 IS DISTINCT FROM OLD.returned_by_2) THEN
      RAISE EXCEPTION 'PAYOUT-32: the recorded return of item % cannot be rewritten', OLD.id
        USING ERRCODE = '23514';
    END IF;
    SELECT b.requested_by INTO batch_requester
      FROM public.payroll_disbursement_batches b
      WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id;
    IF NEW.returned_by IS NOT DISTINCT FROM batch_requester
      OR NEW.returned_by_2 IS NOT DISTINCT FROM batch_requester THEN
      RAISE EXCEPTION 'PAYOUT-32: the requester of the batch cannot return item %', OLD.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  -- A return that went through the two-person proposal must be complete. A
  -- bare succeeded -> returned (no proposal recorded) stays legal at this
  -- level, as in 0344; the service always records the proposal first.
  IF NEW.status = 'returned' AND OLD.status IS DISTINCT FROM 'returned' AND NEW.returned_by IS NOT NULL THEN
    SELECT b.requested_by INTO batch_requester
      FROM public.payroll_disbursement_batches b
      WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id;
    IF NEW.returned_by IS NULL
      OR NEW.returned_by_2 IS NULL
      OR NEW.returned_by = NEW.returned_by_2
      OR NEW.returned_by = batch_requester
      OR NEW.returned_by_2 = batch_requester
      OR NEW.return_evidence_key IS NULL
      OR NEW.returned_at IS NULL THEN
      RAISE EXCEPTION 'PAYOUT-32: item % can become returned only after two different people (not the requester) agreed with evidence', OLD.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payroll_disbursement_items_payout_gl_guard_trg ON public.payroll_disbursement_items;
--> statement-breakpoint
CREATE TRIGGER payroll_disbursement_items_payout_gl_guard_trg
  BEFORE UPDATE ON public.payroll_disbursement_items
  FOR EACH ROW EXECUTE FUNCTION app.payroll_disbursement_items_payout_gl_guard();
--> statement-breakpoint
-- The new `bank_charges` posting role (Q15: the bank fee is borne by the PT).
-- New entities get it from the standard chart (account 8101). An entity
-- provisioned earlier lacks the mapping: map the role to its 8101 when that is
-- an active expense account with no child account and the role has no mapping
-- yet. Idempotent, never updates or deletes. FORCE RLS is lifted for this one
-- statement and restored, as in 0155 and 0335.
ALTER TABLE public.chart_of_accounts NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.account_mappings NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO public.account_mappings (tenant_id, legal_entity_id, role, account_id)
SELECT a.tenant_id, a.legal_entity_id, 'bank_charges', a.id
FROM public.chart_of_accounts a
WHERE a.code = '8101'
  AND a.type = 'expense'
  AND a.is_active
  AND EXISTS (
    SELECT 1 FROM public.account_mappings p
    WHERE p.tenant_id = a.tenant_id AND p.legal_entity_id = a.legal_entity_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.account_mappings x
    WHERE x.tenant_id = a.tenant_id AND x.legal_entity_id = a.legal_entity_id AND x.role = 'bank_charges'
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.chart_of_accounts c
    WHERE c.tenant_id = a.tenant_id AND c.legal_entity_id = a.legal_entity_id AND c.parent_id = a.id
  )
ON CONFLICT (tenant_id, legal_entity_id, role) DO NOTHING;
--> statement-breakpoint
ALTER TABLE public.account_mappings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.chart_of_accounts FORCE ROW LEVEL SECURITY;
