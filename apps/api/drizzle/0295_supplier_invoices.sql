-- Foreign keys are inline: FORCE RLS on the referenced tables makes a later
-- ALTER TABLE ADD CONSTRAINT fail 42501 for a plain owner (as 0279, 0287).
CREATE TABLE "supplier_invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"invoice_number" varchar(60) NOT NULL,
	"invoice_date" date NOT NULL,
	"dpp_idr" bigint NOT NULL,
	"ppn_idr" bigint NOT NULL,
	"pph23_idr" bigint NOT NULL,
	"payable_idr" bigint NOT NULL,
	"journal_entry_id" uuid,
	"npwp_snapshot" varchar(20),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_invoices_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "supplier_invoices_tenant_supplier_number_key" UNIQUE("tenant_id","supplier_id","invoice_number"),
	CONSTRAINT "supplier_invoices_amounts_check" CHECK ("supplier_invoices"."dpp_idr" >= 0 AND "supplier_invoices"."ppn_idr" >= 0 AND "supplier_invoices"."pph23_idr" >= 0 AND "supplier_invoices"."payable_idr" > 0),
	CONSTRAINT "supplier_invoices_number_check" CHECK (length(btrim("supplier_invoices"."invoice_number")) > 0),
	CONSTRAINT "supplier_invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "supplier_invoices_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."suppliers"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "supplier_invoices_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "supplier_invoices_journal_fk" FOREIGN KEY ("tenant_id","journal_entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "supplier_invoices_period_idx" ON "supplier_invoices" USING btree ("tenant_id","legal_entity_id","invoice_date");--> statement-breakpoint
-- TEN-01: tenant-owned (supplier invoices are legal-entity level, no outlet).
SELECT app.enforce_tenant_rls('public.supplier_invoices'::regclass);
--> statement-breakpoint
-- Tax records are append-only: the tax reports reconcile against them, so the
-- application login may insert and read, never change or remove a row.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.supplier_invoices FROM legend_app;
