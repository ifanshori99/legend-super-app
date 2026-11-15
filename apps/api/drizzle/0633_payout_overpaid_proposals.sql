-- legend-v6gtp: a transfer that turns out paid twice (late success of a failed
-- attempt) is recorded over HTTP by two DIFFERENT non-requesters, like resolve
-- and return. Step one writes a proposal here (the item stays `failed`, no
-- journal); step two, by another person, records the overpaid item through
-- recordOverpaidItem and marks the proposal `recorded`. One proposal per item,
-- ever: an item can only become `overpaid` once.
CREATE TABLE "payroll_payout_overpaid_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"evidence_key" varchar(500) NOT NULL,
	"note" varchar(500) NOT NULL,
	"status" varchar(8) DEFAULT 'proposed' NOT NULL,
	"proposed_by" text NOT NULL,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by" text,
	"recorded_at" timestamp with time zone,
	CONSTRAINT "payroll_payout_overpaid_proposals_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payroll_payout_overpaid_proposals_item_key" UNIQUE("tenant_id","item_id"),
	CONSTRAINT "payroll_payout_overpaid_proposals_status_check" CHECK ("payroll_payout_overpaid_proposals"."status" IN ('proposed', 'recorded')),
	CONSTRAINT "payroll_payout_overpaid_proposals_recorded_check" CHECK (("payroll_payout_overpaid_proposals"."status" = 'proposed' AND "payroll_payout_overpaid_proposals"."recorded_by" IS NULL AND "payroll_payout_overpaid_proposals"."recorded_at" IS NULL) OR ("payroll_payout_overpaid_proposals"."status" = 'recorded' AND "payroll_payout_overpaid_proposals"."recorded_by" IS NOT NULL AND "payroll_payout_overpaid_proposals"."recorded_at" IS NOT NULL AND "payroll_payout_overpaid_proposals"."recorded_by" <> "payroll_payout_overpaid_proposals"."proposed_by")),
	CONSTRAINT "payroll_payout_overpaid_proposals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_overpaid_proposals_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."payroll_disbursement_batches"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_overpaid_proposals_item_fk" FOREIGN KEY ("tenant_id","item_id") REFERENCES "public"."payroll_disbursement_items"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "payroll_payout_overpaid_proposals_tenant_batch_idx" ON "payroll_payout_overpaid_proposals" USING btree ("tenant_id","batch_id");--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payroll_payout_overpaid_proposals'::regclass);
--> statement-breakpoint
-- A proposal is the record of who said what: never erased.
REVOKE DELETE, TRUNCATE ON TABLE public.payroll_payout_overpaid_proposals FROM legend_app;
--> statement-breakpoint
-- Only two changes are allowed: the same proposer replaces a still-open
-- proposal (new proof or note, wrong first entry), or a different person turns
-- an open proposal into `recorded` (the other columns stay as they were).
CREATE OR REPLACE FUNCTION app.payroll_payout_overpaid_proposals_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.status = 'proposed' AND NEW.status = 'recorded'
    AND NEW.recorded_by IS NOT NULL AND NEW.recorded_by <> OLD.proposed_by
    AND NEW.recorded_at IS NOT NULL
    AND (to_jsonb(NEW) - 'status' - 'recorded_by' - 'recorded_at')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'status' - 'recorded_by' - 'recorded_at') THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'proposed' AND NEW.status = 'proposed'
    AND (to_jsonb(NEW) - 'evidence_key' - 'note' - 'proposed_at')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'evidence_key' - 'note' - 'proposed_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PAYOUT-33: overpaid proposal % cannot change', OLD.id
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payroll_payout_overpaid_proposals_guard_trg ON public.payroll_payout_overpaid_proposals;
--> statement-breakpoint
CREATE TRIGGER payroll_payout_overpaid_proposals_guard_trg
  BEFORE UPDATE ON public.payroll_payout_overpaid_proposals
  FOR EACH ROW EXECUTE FUNCTION app.payroll_payout_overpaid_proposals_guard();
