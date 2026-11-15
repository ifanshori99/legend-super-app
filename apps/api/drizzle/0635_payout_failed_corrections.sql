-- legend-mejr2: a `failed` item that did reach the employee after all, with no
-- other attempt paid, is corrected to `succeeded` without paying a second time.
-- It takes two DIFFERENT people (neither the batch requester nor either person
-- who resolved the item as failed), one bank proof, and the settle journal
-- (Dr salaries payable / Cr the source account) posts exactly once. Step one
-- writes a proposal here (the item stays `failed`, no journal); step two, by
-- another person with the same proof, marks the rows `corrected` and the
-- service moves the items (guard in 0636). One row per item, ever.
-- All items of one request share `operation_id` (the id of the first row of the
-- request). The proof is bound to that ONE operation: its evidence key and each
-- of its two hashes (uploaded bytes, stored bytes) are unique per tenant over
-- the first rows only, so a proof cannot back a second correction under a new
-- key either. The hash of zero bytes is recorded but never identifies a proof.
CREATE TABLE "payroll_payout_failed_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"evidence_key" varchar(500) NOT NULL,
	"content_sha256" varchar(64) NOT NULL,
	"stored_sha256" varchar(64) NOT NULL,
	"note" varchar(500) NOT NULL,
	"status" varchar(9) DEFAULT 'proposed' NOT NULL,
	"proposed_by" text NOT NULL,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"corrected_by" text,
	"corrected_at" timestamp with time zone,
	CONSTRAINT "payroll_payout_failed_corrections_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payroll_payout_failed_corrections_item_key" UNIQUE("tenant_id","item_id"),
	CONSTRAINT "payroll_payout_failed_corrections_status_check" CHECK ("payroll_payout_failed_corrections"."status" IN ('proposed', 'corrected')),
	CONSTRAINT "payroll_payout_failed_corrections_sha_check" CHECK ("payroll_payout_failed_corrections"."content_sha256" ~ '^[a-f0-9]{64}$' AND "payroll_payout_failed_corrections"."stored_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "payroll_payout_failed_corrections_corrected_check" CHECK (("payroll_payout_failed_corrections"."status" = 'proposed' AND "payroll_payout_failed_corrections"."corrected_by" IS NULL AND "payroll_payout_failed_corrections"."corrected_at" IS NULL) OR ("payroll_payout_failed_corrections"."status" = 'corrected' AND "payroll_payout_failed_corrections"."corrected_by" IS NOT NULL AND "payroll_payout_failed_corrections"."corrected_at" IS NOT NULL AND "payroll_payout_failed_corrections"."corrected_by" <> "payroll_payout_failed_corrections"."proposed_by")),
	CONSTRAINT "payroll_payout_failed_corrections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_failed_corrections_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."payroll_disbursement_batches"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_failed_corrections_item_fk" FOREIGN KEY ("tenant_id","item_id") REFERENCES "public"."payroll_disbursement_items"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_payout_failed_corrections_evidence_key" ON "payroll_payout_failed_corrections" USING btree ("tenant_id","evidence_key") WHERE "payroll_payout_failed_corrections"."operation_id" = "payroll_payout_failed_corrections"."id";--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_payout_failed_corrections_content_sha_key" ON "payroll_payout_failed_corrections" USING btree ("tenant_id","content_sha256") WHERE "payroll_payout_failed_corrections"."operation_id" = "payroll_payout_failed_corrections"."id" AND "payroll_payout_failed_corrections"."content_sha256" <> 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_payout_failed_corrections_stored_sha_key" ON "payroll_payout_failed_corrections" USING btree ("tenant_id","stored_sha256") WHERE "payroll_payout_failed_corrections"."operation_id" = "payroll_payout_failed_corrections"."id" AND "payroll_payout_failed_corrections"."stored_sha256" <> 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';--> statement-breakpoint
CREATE INDEX "payroll_payout_failed_corrections_tenant_batch_idx" ON "payroll_payout_failed_corrections" USING btree ("tenant_id","batch_id");--> statement-breakpoint
CREATE INDEX "payroll_payout_failed_corrections_tenant_operation_idx" ON "payroll_payout_failed_corrections" USING btree ("tenant_id","operation_id");--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payroll_payout_failed_corrections'::regclass);
--> statement-breakpoint
-- A correction is the record of who said what: never erased.
REVOKE DELETE, TRUNCATE ON TABLE public.payroll_payout_failed_corrections FROM legend_app;
--> statement-breakpoint
-- A new row is always an open proposal: a row cannot be inserted already
-- `corrected` with an invented approver. After that only two changes are allowed: the same proposer replaces a still-open
-- proposal (new proof, hashes or note; the operation and the proposer stay), or
-- a different person turns an open proposal into `corrected` (the other
-- columns stay as they were).
CREATE OR REPLACE FUNCTION app.payroll_payout_failed_corrections_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'proposed' AND NEW.corrected_by IS NULL AND NEW.corrected_at IS NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'PAYOUT-34: failed correction % must start as an open proposal', NEW.id
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'proposed' AND NEW.status = 'corrected'
    AND NEW.corrected_by IS NOT NULL AND NEW.corrected_by <> OLD.proposed_by
    AND NEW.corrected_at IS NOT NULL
    AND (to_jsonb(NEW) - 'status' - 'corrected_by' - 'corrected_at')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'status' - 'corrected_by' - 'corrected_at') THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'proposed' AND NEW.status = 'proposed'
    AND (to_jsonb(NEW) - 'evidence_key' - 'content_sha256' - 'stored_sha256' - 'note' - 'proposed_at')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'evidence_key' - 'content_sha256' - 'stored_sha256' - 'note' - 'proposed_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PAYOUT-34: failed correction % cannot change', OLD.id
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payroll_payout_failed_corrections_guard_trg ON public.payroll_payout_failed_corrections;
--> statement-breakpoint
CREATE TRIGGER payroll_payout_failed_corrections_guard_trg
  BEFORE INSERT OR UPDATE ON public.payroll_payout_failed_corrections
  FOR EACH ROW EXECUTE FUNCTION app.payroll_payout_failed_corrections_guard();
