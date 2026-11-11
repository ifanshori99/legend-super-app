-- Breakfast fire window (bead oa0qk, CTO decision after Q43): a breakfast
-- order reaches the kitchen only while its access ticket is still running.
-- A linked order marked fired at or after access_tickets.ends_at is refused
-- by the kitchen triggers (23514 kitchen_tickets_breakfast_paid), even when
-- the worker was down. fired_at is compared, not now(), so the answer is
-- deterministic (tests use an injected clock). A missing ticket does not pass.
-- Mirrors the fragment in src/db/schema/kds.custom.sql. CREATE OR REPLACE
-- keeps the owner and the grants; the triggers and the item helper are unchanged.
CREATE OR REPLACE FUNCTION app.breakfast_order_unpaid(p_tenant uuid, p_order uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT (
           EXISTS (
             SELECT 1 FROM public.orders o
             WHERE o.tenant_id = p_tenant AND o.id = p_order AND o.channel = 'facility'
           )
           OR EXISTS (
             SELECT 1 FROM public.facility_linked_orders f
             WHERE f.tenant_id = p_tenant AND f.order_id = p_order
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM public.facility_linked_orders f
           JOIN public.access_tickets a
             ON a.tenant_id = f.tenant_id AND a.id = f.access_ticket_id
           WHERE f.tenant_id = p_tenant AND f.order_id = p_order
             AND f.paid_at IS NOT NULL AND f.status = 'fired'
             AND f.fired_at IS NOT NULL AND f.fired_at < a.ends_at
         );
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.breakfast_order_unpaid(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.breakfast_order_unpaid(uuid, uuid) TO legend_app;
