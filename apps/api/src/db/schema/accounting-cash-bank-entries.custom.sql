-- Cash in/out, bank transfers and petty cash fund (bead legend-4961, WS-07;
-- PRD v1.7 §3.19 Kas & Bank). Tenant RLS on every table (TEN-01/02).
-- cash_bank_entries is tenant-level (outlet_id is an optional cost tag), so it
-- has no outlet policy; outlet reach is enforced in the service like the other
-- accounting tables. The petty cash fund and its ledger are outlet-owned
-- (outlet_id NOT NULL), so they also get the outlet policy (TEN-03, guard
-- src/db/outlet-rls.test.ts).
SELECT app.enforce_tenant_rls('public.cash_bank_entries'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.petty_cash_funds'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.petty_cash_funds'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.petty_cash_entries'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.petty_cash_entries'::regclass);
--> statement-breakpoint
-- Cash/bank documents are append-only for the application role: a correction
-- is a reversing journal and a new document, never an edited or deleted one.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.cash_bank_entries FROM legend_app;
--> statement-breakpoint
-- The fund row only changes its balance (under a row lock, never below zero).
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.petty_cash_funds FROM legend_app;
--> statement-breakpoint
GRANT UPDATE (balance_idr, updated_at) ON TABLE public.petty_cash_funds TO legend_app;
--> statement-breakpoint
-- The fund ledger is append-only except for the journal link of a parked
-- entry, which is posted later (retry).
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.petty_cash_entries FROM legend_app;
--> statement-breakpoint
GRANT UPDATE (journal_status, journal_entry_id, park_code, park_attempts) ON TABLE public.petty_cash_entries TO legend_app;
--> statement-breakpoint
-- Cash-out approval (0497): a pending entry may only gain its decision.
GRANT UPDATE (status, approver_id, decided_at, decision_reason, journal_entry_id) ON TABLE public.cash_bank_entries TO legend_app;
