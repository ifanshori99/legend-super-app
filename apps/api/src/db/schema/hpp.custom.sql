-- HPP read model and recompute queue (bead legend-2qq; PRD v1.7 §17 "HPP
-- Menu"). RLS for menu_costs, hpp_recompute_queue and hpp_outlet_state (hpp.ts). CHECK, unique
-- and foreign keys live in the drizzle schema; this file holds RLS. Fold into
-- the migration after the generated CREATE TABLE (0278_hpp_recompute).

-- TEN-01/TEN-03: all three tables are tenant + outlet owned (outlet_id NOT NULL).
SELECT app.enforce_tenant_rls('public.menu_costs'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.menu_costs'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.hpp_recompute_queue'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.hpp_recompute_queue'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.hpp_outlet_state'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.hpp_outlet_state'::regclass);
