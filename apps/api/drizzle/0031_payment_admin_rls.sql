-- Custom SQL migration file, put your code below! ---
SELECT app.enforce_tenant_rls('public.payment_admin_idempotency'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payment_cashier_defaults'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payment_edc_terminals'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payment_reconciliation_cases'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payment_refunds'::regclass);
