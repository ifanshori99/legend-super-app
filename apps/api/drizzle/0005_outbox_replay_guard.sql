-- Dispatch state guards enforced in the database, not only in core-outbox.ts:
-- a dead letter leaves 'dead' only through an operator replay (generation + 1)
-- that is audited in domain_event_replays in the same transaction; generations
-- never move backwards; a delivered row never becomes undelivered.
CREATE FUNCTION app.guard_outbox_dispatch() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.status = 'delivered' AND NEW.status <> 'delivered' THEN
    RAISE EXCEPTION 'Delivered outbox rows cannot be reopened' USING ERRCODE = '42501';
  END IF;
  IF NEW.dispatch_generation < OLD.dispatch_generation THEN
    RAISE EXCEPTION 'Outbox dispatch generation cannot decrease' USING ERRCODE = '42501';
  END IF;
  IF OLD.dispatch_state = 'dead' AND NEW.dispatch_state <> 'dead' THEN
    IF NEW.dispatch_state <> 'ready' OR NEW.dispatch_generation <> OLD.dispatch_generation + 1 THEN
      RAISE EXCEPTION 'A dead letter is requeued only by an operator replay' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.dispatch_generation <> OLD.dispatch_generation THEN
    RAISE EXCEPTION 'Only a dead-letter replay advances the dispatch generation' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER domain_event_outbox_dispatch_guard BEFORE UPDATE ON public.domain_event_outbox
  FOR EACH ROW EXECUTE FUNCTION app.guard_outbox_dispatch();
--> statement-breakpoint
CREATE FUNCTION app.require_outbox_replay_audit() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.domain_event_replays r
    WHERE r.tenant_id = NEW.tenant_id AND r.outbox_id = NEW.id
      AND r.generation = NEW.dispatch_generation
  ) THEN
    RAISE EXCEPTION 'Dead-letter replay requires an audit record' USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER domain_event_outbox_replay_audit
  AFTER UPDATE ON public.domain_event_outbox
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.dispatch_state = 'dead' AND NEW.dispatch_state <> 'dead')
  EXECUTE FUNCTION app.require_outbox_replay_audit();
