-- WFC payment capture ledger (bead legend-bz9h round 3): every row is tenant
-- and outlet owned, so both guards apply (TEN-01, TEN-03). Append this block to
-- the generated wfc_payment_captures migration.
SELECT app.enforce_tenant_rls('public.wfc_payment_captures'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wfc_payment_captures'::regclass);
