-- A queued dispatch whose pg-boss job vanished (queue row removed, schema
-- recreated, or a job that never reached a dead letter) would otherwise keep
-- the aggregate blocked forever: the row is not 'ready', so the relay never
-- re-enqueues it, and the next aggregate sequence cannot be claimed.
-- The relay recovers such a row only after its queued lease expired, and only
-- by returning it to 'ready' with the dispatch generation advanced, so a late
-- job from the lost dispatch is fenced by consumeOutbox.
--
-- dispatch_lease_until is the relay claim window on a ready row and the job
-- deadline on a queued row; the queued branch of the check now carries it.
ALTER TABLE public.domain_event_outbox DROP CONSTRAINT domain_event_outbox_dispatch_check;
--> statement-breakpoint
ALTER TABLE public.domain_event_outbox ADD CONSTRAINT domain_event_outbox_dispatch_check CHECK ((
  dispatch_generation >= 0 AND
  ((dispatch_state = 'ready' AND dispatch_job_id IS NULL AND dead_lettered_at IS NULL
    AND ((dispatch_lease_token IS NULL AND dispatch_lease_until IS NULL) OR (dispatch_lease_token IS NOT NULL AND dispatch_lease_until IS NOT NULL)))
   OR (dispatch_state = 'queued' AND dispatch_job_id IS NOT NULL AND dead_lettered_at IS NULL AND dispatch_lease_token IS NULL)
   OR (dispatch_state = 'dead' AND dead_lettered_at IS NOT NULL AND dispatch_lease_token IS NULL AND dispatch_lease_until IS NULL))
) IS TRUE);
--> statement-breakpoint
-- Rows queued before this migration have no job deadline and could never be
-- recovered. Give them the same lease the relay now writes; a job that is
-- truly lost is re-dispatched on a later sweep.
UPDATE public.domain_event_outbox
  SET dispatch_lease_until = now() + interval '20 minutes'
  WHERE dispatch_state = 'queued' AND dispatch_lease_until IS NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.guard_outbox_dispatch() RETURNS trigger
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
  ELSIF OLD.dispatch_state = 'queued' AND NEW.dispatch_state = 'ready'
    AND NEW.dispatch_generation = OLD.dispatch_generation + 1 THEN
    IF OLD.dispatch_lease_until IS NULL OR OLD.dispatch_lease_until >= now() THEN
      RAISE EXCEPTION 'A queued dispatch is recovered only after its lease expires' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.dispatch_generation <> OLD.dispatch_generation THEN
    RAISE EXCEPTION 'Only a dead-letter replay or an expired queued lease advances the dispatch generation' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- The recovery sweep looks for expired queued rows only; keep that lookup off
-- the full outbox history.
CREATE INDEX IF NOT EXISTS domain_event_outbox_queued_lease_idx
  ON public.domain_event_outbox (tenant_id, dispatch_lease_until)
  WHERE dispatch_state = 'queued';
