-- Tax and service-charge isolation (PRD v1.7 §3.14 / F11 F14, §6.C
-- `tax_rules` / `service_charge_rules`, D13; TEN-01/02/03, bead legend-559).
-- Every table is tenant-owned: tenant_id NOT NULL with a RESTRICTIVE
-- tenant_isolation policy, plus the DML grants to the non-bypass application
-- role. The composite (tenant_id, outlet_id) and (tenant_id, tax_rule_id)
-- foreign keys in 0024 already stop a privileged writer from pointing a rule
-- or a snapshot at another tenant's outlet or rule.
--
-- Run order: after the generated tables migration (0024). Never replay the
-- 119connect migrations; this is the Legend policy.
SELECT app.enforce_tenant_rls('public.tax_rules'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.service_charge_rules'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.tax_settings'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.tax_snapshots'::regclass);
