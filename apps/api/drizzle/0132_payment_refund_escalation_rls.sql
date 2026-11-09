-- Custom SQL migration file, put your code below! --
-- legend-n9kn: RLS for the per-tenant refund escalation thresholds created in 0103.
SELECT app.enforce_tenant_rls('public.payment_refund_escalation_settings'::regclass);
