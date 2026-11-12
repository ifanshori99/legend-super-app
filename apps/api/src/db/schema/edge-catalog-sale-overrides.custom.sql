-- WS-02 edge (bead legend-10nex): owner override of the 24 h stale-catalog
-- sales block. Tenant RLS (TEN-01/02) plus the outlet backstop (TEN-03). Not
-- append-only: superseded_at / closed_at / closed_reason are set after the grant.
SELECT app.enforce_tenant_rls('public.edge_catalog_sale_overrides'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_catalog_sale_overrides'::regclass);
