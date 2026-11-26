-- Custom SQL migration file, put your code below! ---
-- 1271 F1 failover windows (0529). Tenant RLS (TEN-01/02) plus the outlet
-- backstop (TEN-03), like the other edge tables.
SELECT app.enforce_tenant_rls('public.outlet_failover_windows'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.outlet_failover_windows'::regclass);
--> statement-breakpoint
-- A window is never deleted, its identity never changes, its status only moves
-- forward (active -> returning -> closed, active -> cancelled), a set-once
-- field keeps its first value, and a closed or cancelled window is final. The
-- row checks tie the timestamps to the status.
CREATE FUNCTION app.guard_outlet_failover_window() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'failover windows are never deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'failover window % is final', OLD.id USING ERRCODE = '42501';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.outlet_id <> OLD.outlet_id OR NEW.edge_node_id <> OLD.edge_node_id
     OR NEW.reason <> OLD.reason OR NEW.override <> OLD.override
     OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.activated_by <> OLD.activated_by
     OR NEW.activated_at <> OLD.activated_at
     OR NEW.edge_heartbeat_at IS DISTINCT FROM OLD.edge_heartbeat_at
     OR NEW.business_date_from <> OLD.business_date_from
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'failover window % identity cannot change', OLD.id
      USING ERRCODE = '42501';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'active' AND NEW.status IN ('returning', 'cancelled'))
    OR (OLD.status = 'returning' AND NEW.status = 'closed')) THEN
    RAISE EXCEPTION 'failover window % cannot move from % to %', OLD.id,
      OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  IF (OLD.business_date_to IS NOT NULL AND NEW.business_date_to IS DISTINCT FROM OLD.business_date_to)
     OR (OLD.return_started_at IS NOT NULL AND NEW.return_started_at IS DISTINCT FROM OLD.return_started_at)
     OR (OLD.return_started_by IS NOT NULL AND NEW.return_started_by IS DISTINCT FROM OLD.return_started_by)
     OR (OLD.closing_event_id IS NOT NULL AND NEW.closing_event_id IS DISTINCT FROM OLD.closing_event_id) THEN
    RAISE EXCEPTION 'failover window % set-once field cannot change', OLD.id
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER outlet_failover_windows_guard BEFORE UPDATE OR DELETE ON public.outlet_failover_windows
FOR EACH ROW EXECUTE FUNCTION app.guard_outlet_failover_window();
--> statement-breakpoint
-- A failover order or shift stays one for good, and a normal one never
-- becomes one: failover_window_id is fixed at insert (D1 echo guard).
CREATE FUNCTION app.failover_window_id_fixed() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.failover_window_id IS DISTINCT FROM OLD.failover_window_id THEN
    RAISE EXCEPTION '% failover_window_id cannot change', TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER pos_orders_failover_window_fixed BEFORE UPDATE OF failover_window_id ON public.pos_orders
FOR EACH ROW EXECUTE FUNCTION app.failover_window_id_fixed();
--> statement-breakpoint
CREATE TRIGGER pos_shifts_failover_window_fixed BEFORE UPDATE OF failover_window_id ON public.pos_shifts
FOR EACH ROW EXECUTE FUNCTION app.failover_window_id_fixed();
