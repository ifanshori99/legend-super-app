-- Custom SQL migration fragment for legend-4b5 (order_issues). Append AFTER the
-- drizzle-generated CREATE TABLE statement for order_issues.
--
-- Tenant + outlet RLS (TEN-01/TEN-03). order_issues has outlet_id NOT NULL.
-- Rows are updated when an open issue is resolved; the API never deletes one.
SELECT app.enforce_tenant_rls('public.order_issues'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.order_issues'::regclass);
--> statement-breakpoint
-- legend-i83ls: order_issue_charges, tenant + outlet RLS. Append AFTER its
-- generated CREATE TABLE. Rows are updated (paid, waived, expired); never deleted.
SELECT app.enforce_tenant_rls('public.order_issue_charges'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.order_issue_charges'::regclass);
--> statement-breakpoint
-- legend-mrwtp: order_issue_charge_manual_refunds, tenant + outlet RLS. Append
-- AFTER its generated CREATE TABLE. Rows are updated (decided); never deleted.
SELECT app.enforce_tenant_rls('public.order_issue_charge_manual_refunds'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.order_issue_charge_manual_refunds'::regclass);
