-- legend-4qu: failed item recovery (apology_vouchers, order_issues.approval_request_id).
-- Number 0214 and its `when` were assigned by the coordinator (0209-0213 belong
-- to other branches). The generated part creates apology_vouchers with every
-- foreign key inline (the table is empty, so FORCE RLS needs no lift), adds
-- the nullable order_issues.approval_request_id, order_issues.replacement_order_item_id
-- (swap result line, composite FK to order_items, once-only unique index and
-- two CHECKs incl. order_issues_swap_approval_check) and partial unique
-- indexes. The custom part at the end adds RLS and makes the new table
-- append-only for legend_app.
--
-- Pre-flight for the two new unique indexes on the existing order_issues
-- table. The KDS path (order-issues.service.ts) can store a resolution and a
-- client-supplied voucher_id with the report, so old rows may repeat them.
-- The migrator may be a plain table owner, and FORCE ROW LEVEL SECURITY would
-- make the read below raise 42501 (no app.tenant_id), so FORCE is lifted for
-- this transaction and restored right after. Nothing is rewritten: a violating
-- row is settled data (voucher_id is required by order_issues_voucher_check),
-- so the migration stops with a clear message and a person decides.
ALTER TABLE public.order_issues NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE
  dup_items integer;
  dup_vouchers integer;
BEGIN
  SELECT count(*) INTO dup_items FROM (
    SELECT 1 FROM public.order_issues
    WHERE type = 'unfulfillable' AND resolution IS NOT NULL
      AND status <> 'cancelled'
    GROUP BY tenant_id, order_item_id HAVING count(*) > 1) d;
  SELECT count(*) INTO dup_vouchers FROM (
    SELECT 1 FROM public.order_issues
    WHERE voucher_id IS NOT NULL
    GROUP BY tenant_id, voucher_id HAVING count(*) > 1) d;
  IF dup_items > 0 OR dup_vouchers > 0 THEN
    RAISE EXCEPTION
      '0214: order_issues has % order line(s) with several settled unfulfillable issues and % voucher id(s) used by several issues; resolve them before migrating',
      dup_items, dup_vouchers;
  END IF;
END
$$;
--> statement-breakpoint
ALTER TABLE public.order_issues FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "apology_vouchers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"voucher_id" uuid NOT NULL,
	"order_issue_id" uuid,
	"reason" varchar(500) NOT NULL,
	"approval_request_id" uuid,
	"code_sealed" text NOT NULL,
	"customer_profile_id" uuid,
	"issued_by" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apology_vouchers_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "apology_vouchers_tenant_voucher_key" UNIQUE("tenant_id","voucher_id"),
	CONSTRAINT "apology_vouchers_reason_check" CHECK (length(btrim("apology_vouchers"."reason")) >= 10)
);
--> statement-breakpoint
ALTER TABLE "order_issues" ADD COLUMN "approval_request_id" uuid;--> statement-breakpoint
-- Lift FORCE RLS on the existing tables the FK validation scans (as the
-- migrator), restored after the last FK (docs/plan/contracts.md pattern 2).
ALTER TABLE public.outlets NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.customer_profiles NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.vouchers NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.order_issues NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "apology_vouchers" ADD CONSTRAINT "apology_vouchers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apology_vouchers" ADD CONSTRAINT "apology_vouchers_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apology_vouchers" ADD CONSTRAINT "apology_vouchers_issued_by_user_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apology_vouchers" ADD CONSTRAINT "apology_vouchers_voucher_fk" FOREIGN KEY ("tenant_id","voucher_id") REFERENCES "public"."vouchers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apology_vouchers" ADD CONSTRAINT "apology_vouchers_order_issue_fk" FOREIGN KEY ("tenant_id","order_issue_id") REFERENCES "public"."order_issues"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apology_vouchers" ADD CONSTRAINT "apology_vouchers_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apology_vouchers" ADD CONSTRAINT "apology_vouchers_profile_fk" FOREIGN KEY ("tenant_id","customer_profile_id") REFERENCES "public"."customer_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE public.order_issues FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.vouchers FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.customer_profiles FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.outlets FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "apology_vouchers_issue_once_idx" ON "apology_vouchers" USING btree ("tenant_id","order_issue_id") WHERE "apology_vouchers"."order_issue_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "apology_vouchers_approval_once_idx" ON "apology_vouchers" USING btree ("tenant_id","approval_request_id") WHERE "apology_vouchers"."approval_request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "apology_vouchers_outlet_issued_idx" ON "apology_vouchers" USING btree ("tenant_id","outlet_id","issued_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_issues_resolved_item_once_idx" ON "order_issues" USING btree ("tenant_id","order_item_id") WHERE "order_issues"."type" = 'unfulfillable' AND "order_issues"."resolution" IS NOT NULL AND "order_issues"."status" <> 'cancelled';--> statement-breakpoint
CREATE UNIQUE INDEX "order_issues_voucher_once_idx" ON "order_issues" USING btree ("tenant_id","voucher_id") WHERE "order_issues"."voucher_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "order_issues" ADD COLUMN "replacement_order_item_id" uuid;
--> statement-breakpoint
-- Lift FORCE RLS on the existing tables the FK validation scans (as the
-- migrator), restored after the last FK (docs/plan/contracts.md pattern 2).
ALTER TABLE public.order_issues NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.order_items NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_issues" ADD CONSTRAINT "order_issues_replacement_order_item_fk" FOREIGN KEY ("tenant_id","replacement_order_item_id") REFERENCES "public"."order_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE public.order_items FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.order_issues FORCE ROW LEVEL SECURITY;--> statement-breakpoint
--> statement-breakpoint
CREATE UNIQUE INDEX "order_issues_replacement_item_once_idx" ON "order_issues" USING btree ("tenant_id","replacement_order_item_id") WHERE "order_issues"."replacement_order_item_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "order_issues" ADD CONSTRAINT "order_issues_swap_approval_check" CHECK ("order_issues"."resolution" IS DISTINCT FROM 'swap' OR "order_issues"."price_difference_idr" IS NULL OR "order_issues"."price_difference_idr" <= 0 OR "order_issues"."approval_request_id" IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "order_issues" ADD CONSTRAINT "order_issues_replacement_order_item_check" CHECK ("order_issues"."replacement_order_item_id" IS NULL OR "order_issues"."resolution" = 'swap');
--> statement-breakpoint
ALTER TABLE "order_issues" ADD COLUMN "replacement_unit_price_idr" bigint;
--> statement-breakpoint
ALTER TABLE "order_issues" ADD CONSTRAINT "order_issues_replacement_unit_price_check" CHECK ("order_issues"."replacement_unit_price_idr" IS NULL OR "order_issues"."resolution" = 'swap');
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- legend-4qu hand SQL (copied from src/db/schema/apology-vouchers.custom.sql).
-- ---------------------------------------------------------------------------
-- Custom SQL migration fragment for legend-4qu (apology_vouchers, migration
-- 0214). Append AFTER the drizzle-generated statements. Keep this file and the
-- migration in step.
--
-- The generated CREATE TABLE carries every foreign key inline (pattern 1: the
-- new table is empty, so FORCE RLS needs no lift).
--
-- Tenant + outlet RLS (TEN-01/TEN-03). apology_vouchers has outlet_id NOT
-- NULL. Append-only for the application role: a voucher is voided on
-- `vouchers`, never by changing or deleting this row.
SELECT app.enforce_tenant_rls('public.apology_vouchers'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.apology_vouchers'::regclass);
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.apology_vouchers FROM legend_app;
