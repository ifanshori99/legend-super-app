-- WS-06 supplier invoices and the tenant purchasing policy (legal-entity AP,
-- bead legend-lspfy / legend-nz13; migration 0491, after the tables of 0490).
-- Foreign keys into FORCE RLS tables are inline in the 0490 CREATE TABLEs
-- (docs/plan/contracts.md, pattern 1).
SELECT app.enforce_tenant_rls('public.purchase_invoices'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.purchase_invoices'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.purchase_invoice_lines'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.purchase_invoice_lines'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.purchasing_policies'::regclass);
--> statement-breakpoint
-- Invoice lines are the evidence of what was billed: append-only.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.purchase_invoice_lines FROM legend_app;
--> statement-breakpoint
-- An invoice is never deleted. Only the match result and the hold decision
-- (matched/held -> released/rejected, with who, when and why) may change.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.purchase_invoices FROM legend_app;
--> statement-breakpoint
GRANT UPDATE (status, decided_by, decided_at, decision_note, journal_entry_id, match_result, match_snapshot, match_note, tolerance_bp, updated_at) ON TABLE public.purchase_invoices TO legend_app;
