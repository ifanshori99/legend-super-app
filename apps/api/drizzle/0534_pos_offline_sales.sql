-- O2 (bead legend-wasr7.6, docs/design/cloud-only-release.md §2 and
-- "Keputusan CTO O2"): the ledger of offline tablet sales the cloud stored
-- (source `offline_tablet`, apart from the edge's edge_order_ingests). One row
-- per (tenant, event id); (sequence_id, sequence_number) unique so one offline
-- receipt number is never two sales. New empty table only: no existing order,
-- shift or receipt changes. Temporary number 0534 (after O1's 0533),
-- renumbered at merge. Foreign keys are inline in CREATE TABLE (contracts.md
-- legend-m007 pattern 1: no validation scan under FORCE RLS).
CREATE TABLE "pos_offline_sales" (
	"tenant_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"kit_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"sequence_id" uuid NOT NULL,
	"sequence_number" integer NOT NULL,
	"state" varchar(10) NOT NULL,
	"reason" varchar(100),
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"received_by" text NOT NULL,
	"original_business_date" date,
	"late_business_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_offline_sales_pkey" PRIMARY KEY("tenant_id","event_id"),
	CONSTRAINT "pos_offline_sales_sequence_number_key" UNIQUE("tenant_id","sequence_id","sequence_number"),
	CONSTRAINT "pos_offline_sales_state_check" CHECK ("pos_offline_sales"."state" IN ('ingested', 'held')),
	CONSTRAINT "pos_offline_sales_reason_check" CHECK (("pos_offline_sales"."state" = 'held') = ("pos_offline_sales"."reason" IS NOT NULL)),
	CONSTRAINT "pos_offline_sales_sequence_number_check" CHECK ("pos_offline_sales"."sequence_number" BETWEEN 1 AND 999999999),
	CONSTRAINT "pos_offline_sales_flags_check" CHECK (jsonb_typeof("pos_offline_sales"."flags") = 'array'),
	CONSTRAINT "pos_offline_sales_late_check" CHECK (("pos_offline_sales"."late_business_date" IS NULL) = ("pos_offline_sales"."original_business_date" IS NULL)
        AND ("pos_offline_sales"."late_business_date" IS NULL OR "pos_offline_sales"."late_business_date" > "pos_offline_sales"."original_business_date")),
	CONSTRAINT "pos_offline_sales_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_offline_sales_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_offline_sales_received_by_user_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_offline_sales_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_offline_sales_kit_fk" FOREIGN KEY ("tenant_id","kit_id") REFERENCES "public"."pos_offline_kits"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_offline_sales_shift_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."pos_shifts"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_offline_sales_sequence_fk" FOREIGN KEY ("tenant_id","sequence_id") REFERENCES "public"."receipt_sequences"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "pos_offline_sales_outlet_idx" ON "pos_offline_sales" USING btree ("tenant_id","outlet_id","state","created_at");
--> statement-breakpoint
-- O2 offline sales ledger (0534). Tenant RLS (TEN-01/02) plus the outlet
-- backstop (TEN-03), like the other POS tables.
SELECT app.enforce_tenant_rls('public.pos_offline_sales'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.pos_offline_sales'::regclass);
--> statement-breakpoint
-- A stored offline sale is the money record of a sale already paid: it never
-- changes and is never deleted.
CREATE FUNCTION app.guard_pos_offline_sale() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'POS-06: offline sale % is append-only', OLD.event_id
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER pos_offline_sales_guard BEFORE UPDATE OR DELETE ON public.pos_offline_sales
FOR EACH ROW EXECUTE FUNCTION app.guard_pos_offline_sale();
