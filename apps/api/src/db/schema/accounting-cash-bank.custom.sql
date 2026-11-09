-- Custom SQL migration file, put your code below! ---
-- Cash & bank (bead legend-fnxl, WS-07; PRD v1.7 §3.19 Kas & Bank; ACC-04,
-- ACC-05). Tenant RLS on every table (TEN-01/02). cash_deposits is
-- outlet-owned (outlet_id NOT NULL), so it also gets the outlet policy
-- (TEN-03, guard src/db/outlet-rls.test.ts). bank accounts, imports, lines and
-- matches belong to a legal entity, and cases have a nullable outlet: outlet
-- reach on those is enforced in services/accounting-*.ts (contracts.md
-- "TEN-03 outlet isolation layers"), like the other accounting tables.
SELECT app.enforce_tenant_rls('public.bank_accounts'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.bank_statement_imports'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.bank_reconciliation_cases'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.bank_reconciliation_case_events'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.bank_statement_lines'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.bank_statement_line_matches'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.bank_statement_match_rejections'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.cash_deposits'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.cash_deposits'::regclass);
--> statement-breakpoint
-- The case action log is append-only for the application role: a correction
-- is a new action, never an edited or deleted one.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.bank_reconciliation_case_events FROM legend_app;
