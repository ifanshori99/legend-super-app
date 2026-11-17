-- Supplier invoice payments through the approval matrix (bead legend-xxqz3).
-- Foreign keys are inline in the CREATE TABLE (docs/plan/contracts.md, pattern 1).
CREATE TABLE "supplier_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"supplier_invoice_id" uuid NOT NULL,
	"amount_idr" bigint NOT NULL,
	"paid_on" date NOT NULL,
	"status" varchar(20) NOT NULL,
	"requested_by" text NOT NULL,
	"approval_chain_id" uuid,
	"approved_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" varchar(500),
	"settlement_id" uuid,
	"journal_entry_id" uuid,
	"idempotency_key" varchar(100) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_payments_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "supplier_payments_idempotency_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "supplier_payments_approval_chain_key" UNIQUE("tenant_id","approval_chain_id"),
	CONSTRAINT "supplier_payments_journal_key" UNIQUE("tenant_id","journal_entry_id"),
	CONSTRAINT "supplier_payments_amount_check" CHECK ("supplier_payments"."amount_idr" > 0),
	CONSTRAINT "supplier_payments_status_check" CHECK ("supplier_payments"."status" IN ('pending_approval', 'approved', 'paid', 'rejected', 'cancelled')),
	CONSTRAINT "supplier_payments_key_check" CHECK (length(btrim("supplier_payments"."idempotency_key")) > 0),
	CONSTRAINT "supplier_payments_approver_check" CHECK ("supplier_payments"."approved_by" IS NULL OR "supplier_payments"."approved_by" <> "supplier_payments"."requested_by"),
	CONSTRAINT "supplier_payments_pending_chain_check" CHECK ("supplier_payments"."status" <> 'pending_approval' OR "supplier_payments"."approval_chain_id" IS NOT NULL),
	CONSTRAINT "supplier_payments_paid_check" CHECK (("supplier_payments"."status" = 'paid') = ("supplier_payments"."journal_entry_id" IS NOT NULL AND "supplier_payments"."settlement_id" IS NOT NULL)),
	CONSTRAINT "supplier_payments_paid_approver_check" CHECK ("supplier_payments"."status" <> 'paid' OR "supplier_payments"."approval_chain_id" IS NULL OR "supplier_payments"."approved_by" IS NOT NULL),
	CONSTRAINT "supplier_payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "supplier_payments_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "supplier_payments_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "supplier_payments_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "supplier_payments_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "supplier_payments_invoice_fk" FOREIGN KEY ("tenant_id","outlet_id","supplier_invoice_id") REFERENCES "public"."purchase_invoices"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "supplier_payments_journal_fk" FOREIGN KEY ("tenant_id","journal_entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "supplier_payments_invoice_status_idx" ON "supplier_payments" USING btree ("tenant_id","supplier_invoice_id","status");
--> statement-breakpoint
-- Supplier invoice payments (bead legend-xxqz3; migration 0465, with the table).
-- Tenant and outlet RLS (TEN-01/02/03). A request is never deleted; only its
-- decision may change, and a paid, rejected or cancelled row is final.
SELECT app.enforce_tenant_rls('public.supplier_payments'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.supplier_payments'::regclass);
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.supplier_payments FROM legend_app;
--> statement-breakpoint
GRANT UPDATE (status, approved_by, decided_at, decision_note, settlement_id, journal_entry_id, updated_at) ON TABLE public.supplier_payments TO legend_app;
--> statement-breakpoint
-- The GRANT limits which columns may change; this trigger limits how. Only an
-- open request (pending_approval, approved) may move forward; a final row is
-- frozen except updated_at. A direct UPDATE is held to the service's rules.
CREATE OR REPLACE FUNCTION app.guard_supplier_payment_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.status IN ('paid', 'rejected', 'cancelled') THEN
    IF (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
      RAISE EXCEPTION 'a % supplier payment is final and cannot be changed', OLD.status
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'approved' AND NEW.status = 'pending_approval' THEN
    RAISE EXCEPTION 'an approved supplier payment cannot return to pending approval'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS supplier_payments_update_guard ON public.supplier_payments;
--> statement-breakpoint
CREATE TRIGGER supplier_payments_update_guard
  BEFORE UPDATE ON public.supplier_payments
  FOR EACH ROW EXECUTE FUNCTION app.guard_supplier_payment_update();
