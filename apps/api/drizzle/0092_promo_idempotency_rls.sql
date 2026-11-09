-- Custom SQL migration file, put your code below! ---
-- Promo command idempotency (bead legend-nloi): tenant RLS (TEN-01/02) on
-- promo_command_idempotency. promotions.outlet_scope (legend-jh27) is a column
-- on an already-protected table, so it needs no policy.
SELECT app.enforce_tenant_rls('public.promo_command_idempotency'::regclass);
