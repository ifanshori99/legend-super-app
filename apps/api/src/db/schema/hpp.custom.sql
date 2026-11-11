-- HPP read model and recompute queue (bead legend-2qq; PRD v1.7 §17 "HPP
-- Menu"). RLS for menu_costs, hpp_recompute_queue and hpp_outlet_state (hpp.ts). CHECK, unique
-- and foreign keys live in the drizzle schema; this file holds RLS. Fold into
-- the migration after the generated CREATE TABLE (0278_hpp_recompute).

-- TEN-01/TEN-03: menu_costs and hpp_recompute_queue are tenant + outlet scoped
-- (outlet_id NOT NULL).
SELECT app.enforce_tenant_rls('public.menu_costs'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.menu_costs'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.hpp_recompute_queue'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.hpp_recompute_queue'::regclass);
--> statement-breakpoint
-- hpp_outlet_state gets TENANT RLS only (no outlet policy): it holds only stale
-- markers, so outlet scoping adds nothing, and an outlet-scoped actor must be
-- able to mark the brand's or tenant's other outlets stale (markHppStale).
SELECT app.enforce_tenant_rls('public.hpp_outlet_state'::regclass);
