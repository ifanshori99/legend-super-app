-- Edge -> cloud commands (card F1, brief 1269). Fold into the generated
-- migration after the CREATE TABLE statements.
SELECT app.enforce_tenant_rls('public.edge_command_requests'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_command_requests'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.edge_command_executions'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_command_executions'::regclass);
--> statement-breakpoint
-- The key and the frozen body never change, the state only moves forward
-- (pending -> unknown -> final) and a final row is frozen. Never deleted.
CREATE FUNCTION app.guard_edge_command_request() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'edge commands are never deleted' USING ERRCODE = '42501';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.outlet_id <> OLD.outlet_id
     OR NEW.id <> OLD.id OR NEW.edge_node_id <> OLD.edge_node_id
     OR NEW.kind <> OLD.kind OR NEW.subject_type <> OLD.subject_type
     OR NEW.subject_id <> OLD.subject_id OR NEW.body <> OLD.body
     OR NEW.body_sha256 <> OLD.body_sha256 OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'an edge command is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status NOT IN ('pending', 'unknown')
     OR (OLD.status = 'unknown' AND NEW.status = 'pending')
     OR NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'an edge command state only moves forward' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER edge_command_requests_guard BEFORE UPDATE OR DELETE ON public.edge_command_requests
FOR EACH ROW EXECUTE FUNCTION app.guard_edge_command_request();
--> statement-breakpoint
-- The cloud record: only the executing transaction moves it, once, to its
-- outcome; the key is spent forever (a tombstone never becomes an execution).
CREATE FUNCTION app.guard_edge_command_execution() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'edge command outcomes are never deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'executing' OR NEW.status NOT IN ('succeeded', 'refused', 'expired')
     OR NEW.tenant_id <> OLD.tenant_id OR NEW.outlet_id <> OLD.outlet_id
     OR NEW.id <> OLD.id OR NEW.edge_node_id <> OLD.edge_node_id
     OR NEW.edge_instance_id <> OLD.edge_instance_id OR NEW.kind <> OLD.kind
     OR NEW.body_sha256 <> OLD.body_sha256 OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'an edge command outcome is final' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER edge_command_executions_guard BEFORE UPDATE OR DELETE ON public.edge_command_executions
FOR EACH ROW EXECUTE FUNCTION app.guard_edge_command_execution();
