-- legend-lt0v4 / second opinion finding 1 (P1): a closed fiscal period could be
-- reopened with no approval. legend_app held UPDATE on the whole fiscal_periods
-- table (0001 grant loop) and the transition trigger of 0270 only checks
-- version = old version + 1, so a raw UPDATE of status/version opened a month
-- without a request, a second person or a snapshot.
--
-- 1. legend_app loses UPDATE on fiscal_periods. It keeps UPDATE (updated_at)
--    only because SELECT ... FOR UPDATE (the period locks of the close and
--    reopen services) needs an UPDATE privilege on at least one column.
-- 2. A close and a reopen are two SECURITY DEFINER functions. The
--    argument must name the session tenant (app.require_tenant_id()) and every
--    query filters by it: the function owner may bypass RLS in production, so
--    the tenant policy is not what protects another tenant here. They check
--    the transition themselves:
--    - close: the period is open, no earlier period of the entity is still
--      open, and a snapshot of the next version exists (the close service
--      writes it first);
--    Both take the legal entity row FOR NO KEY UPDATE before the period row (the
--    lock order of the services), so a reopen and a close of one entity
--    serialize and the second one checks the committed result of the first.
--    - reopen: the period is closed, the request belongs to it, is approved,
--      was decided by p_actor, the approver is neither the requester nor the
--      person who closed the period, and the approval is unused. "Used" is a
--      hard marker, not a clock comparison: period_reopen_requests.consumed_at
--      is set by the function in the same statement flow, under a row lock on
--      the request, and a filled value refuses the call. One approval = one
--      reopen, also against two concurrent callers and against a frozen clock.
-- 3. legend_app keeps UPDATE on period_reopen_requests only for the decision
--    columns (status, decided_by, decided_at, decision_note, updated_at), never
--    for consumed_at.
-- 4. legend_app cannot forge or rewrite a request row (trigger below, for every
--    role but the table owner; the migration owner stays free for fixtures and
--    repairs). Remaining risk, accepted: the reopen function takes the approver
--    as the text p_actor and no session setting names the acting user, so it
--    trusts the decided_by stored on the request. The guard makes that stored
--    value reachable only through a pending -> approved step with
--    decided_by <> requested_by; it cannot prove who made the call.
ALTER TABLE "period_reopen_requests" ADD COLUMN "consumed_at" timestamp with time zone;
--> statement-breakpoint
-- Every approval made before this migration reopened its period at once, so
-- every old approved row is already spent. Without this backfill the reopen
-- function would read them as unused and an old approval could reopen a month
-- that was closed again later. Same FORCE RLS handling as 0271: the migrator
-- may be a plain table owner with no app.tenant_id set.
ALTER TABLE public.period_reopen_requests NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE public.period_reopen_requests
  SET consumed_at = decided_at
  WHERE status = 'approved' AND consumed_at IS NULL;
--> statement-breakpoint
ALTER TABLE public.period_reopen_requests FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION app.close_fiscal_period(
  p_tenant uuid,
  p_period_id uuid,
  p_actor text,
  p_now timestamptz
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  per record;
  ent uuid;
BEGIN
  IF p_tenant IS DISTINCT FROM app.require_tenant_id() THEN
    RAISE EXCEPTION 'fiscal period close tenant does not match the session tenant'
      USING ERRCODE = '42501';
  END IF;
  IF p_actor IS NULL OR btrim(p_actor) = '' OR p_now IS NULL THEN
    RAISE EXCEPTION 'fiscal period close needs an actor and a time (FISCAL_PERIOD_TRANSITION)'
      USING ERRCODE = '23514';
  END IF;
  -- Lock order of the services: legal entity row first (read unlocked to learn
  -- it), then the period row. Two transitions of one entity serialize here, so
  -- the order checks below read the committed result of the other one.
  SELECT legal_entity_id INTO ent
    FROM public.fiscal_periods
    WHERE tenant_id = p_tenant AND id = p_period_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fiscal period % not found (FISCAL_PERIOD_TRANSITION)', p_period_id
      USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.legal_entities
    WHERE tenant_id = p_tenant AND id = ent FOR NO KEY UPDATE;
  SELECT id, period, status, version INTO per
    FROM public.fiscal_periods
    WHERE tenant_id = p_tenant AND id = p_period_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fiscal period % not found (FISCAL_PERIOD_TRANSITION)', p_period_id
      USING ERRCODE = '23514';
  END IF;
  IF per.status <> 'open' THEN
    RAISE EXCEPTION 'fiscal period % is not open (FISCAL_PERIOD_TRANSITION)', per.period
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.fiscal_periods earlier
    WHERE earlier.tenant_id = p_tenant AND earlier.legal_entity_id = ent
      AND earlier.period < per.period AND earlier.status = 'open'
  ) THEN
    RAISE EXCEPTION 'an earlier fiscal period of the entity is still open; close % is out of order (FISCAL_PERIOD_TRANSITION)', per.period
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.fiscal_period_snapshots s
    WHERE s.tenant_id = p_tenant AND s.fiscal_period_id = per.id
      AND s.version = per.version + 1
  ) THEN
    RAISE EXCEPTION 'fiscal period % has no close snapshot for version % (FISCAL_PERIOD_TRANSITION)', per.period, per.version + 1
      USING ERRCODE = '23514';
  END IF;
  UPDATE public.fiscal_periods
    SET status = 'closed', version = per.version + 1,
        closed_by = p_actor, closed_at = p_now, updated_at = p_now
    WHERE tenant_id = p_tenant AND id = per.id;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.reopen_fiscal_period(
  p_tenant uuid,
  p_period_id uuid,
  p_request_id uuid,
  p_actor text,
  p_now timestamptz
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  per record;
  req record;
  ent uuid;
BEGIN
  IF p_tenant IS DISTINCT FROM app.require_tenant_id() THEN
    RAISE EXCEPTION 'fiscal period reopen tenant does not match the session tenant'
      USING ERRCODE = '42501';
  END IF;
  IF p_actor IS NULL OR btrim(p_actor) = '' OR p_now IS NULL THEN
    RAISE EXCEPTION 'fiscal period reopen needs an actor and a time (FISCAL_PERIOD_TRANSITION)'
      USING ERRCODE = '23514';
  END IF;
  -- Lock order of the services: legal entity row first (read unlocked to learn
  -- it), then the period row. Two transitions of one entity serialize here, so
  -- the order checks below read the committed result of the other one.
  SELECT legal_entity_id INTO ent
    FROM public.fiscal_periods
    WHERE tenant_id = p_tenant AND id = p_period_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fiscal period % not found (FISCAL_PERIOD_TRANSITION)', p_period_id
      USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.legal_entities
    WHERE tenant_id = p_tenant AND id = ent FOR NO KEY UPDATE;
  SELECT id, legal_entity_id, period, status, version, closed_by, closed_at INTO per
    FROM public.fiscal_periods
    WHERE tenant_id = p_tenant AND id = p_period_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fiscal period % not found (FISCAL_PERIOD_TRANSITION)', p_period_id
      USING ERRCODE = '23514';
  END IF;
  IF per.status <> 'closed' THEN
    RAISE EXCEPTION 'fiscal period % is not closed (FISCAL_PERIOD_TRANSITION)', per.period
      USING ERRCODE = '23514';
  END IF;
  -- Only the latest closed period of the entity reopens (the service checks
  -- the same in decidePeriodReopen).
  IF EXISTS (
    SELECT 1 FROM public.fiscal_periods later
    WHERE later.tenant_id = p_tenant AND later.legal_entity_id = per.legal_entity_id
      AND later.period > per.period AND later.status = 'closed'
  ) THEN
    RAISE EXCEPTION 'a later fiscal period of the entity is closed; reopen % is out of order (REOPEN_OUT_OF_ORDER)', per.period
      USING ERRCODE = '23514';
  END IF;
  SELECT id, fiscal_period_id, status, reason, requested_by, decided_by, decided_at, consumed_at INTO req
    FROM public.period_reopen_requests
    WHERE tenant_id = p_tenant AND id = p_request_id
    FOR UPDATE;
  IF NOT FOUND OR req.fiscal_period_id <> per.id THEN
    RAISE EXCEPTION 'no reopen request % for fiscal period % (REOPEN_NOT_APPROVED)', p_request_id, per.period
      USING ERRCODE = '23514';
  END IF;
  IF req.status <> 'approved' OR req.decided_by IS NULL OR req.decided_at IS NULL THEN
    RAISE EXCEPTION 'reopen request % is not approved (REOPEN_NOT_APPROVED)', p_request_id
      USING ERRCODE = '23514';
  END IF;
  IF req.decided_by <> p_actor THEN
    RAISE EXCEPTION 'reopen request % was not approved by the acting user (REOPEN_NOT_APPROVED)', p_request_id
      USING ERRCODE = '23514';
  END IF;
  IF req.decided_by = req.requested_by THEN
    RAISE EXCEPTION 'reopen request % is approved by its requester (REOPEN_SELF_APPROVAL)', p_request_id
      USING ERRCODE = '23514';
  END IF;
  IF req.decided_by = per.closed_by THEN
    RAISE EXCEPTION 'reopen request % is approved by whoever closed the period (REOPEN_SELF_APPROVAL)', p_request_id
      USING ERRCODE = '23514';
  END IF;
  IF req.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'reopen request % was already used for a reopen (REOPEN_APPROVAL_USED)', p_request_id
      USING ERRCODE = '23514';
  END IF;
  UPDATE public.period_reopen_requests
    SET consumed_at = p_now
    WHERE tenant_id = p_tenant AND id = req.id;
  UPDATE public.fiscal_periods
    SET status = 'open', version = per.version + 1,
        closed_by = NULL, closed_at = NULL,
        reopened_reason = btrim(req.reason), reopened_by = p_actor, reopened_at = p_now,
        updated_at = p_now
    WHERE tenant_id = p_tenant AND id = per.id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.close_fiscal_period(uuid, uuid, text, timestamptz) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.reopen_fiscal_period(uuid, uuid, uuid, text, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.close_fiscal_period(uuid, uuid, text, timestamptz) TO legend_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.reopen_fiscal_period(uuid, uuid, uuid, text, timestamptz) TO legend_app;
--> statement-breakpoint
REVOKE UPDATE ON TABLE public.fiscal_periods FROM legend_app;
--> statement-breakpoint
GRANT UPDATE (updated_at) ON TABLE public.fiscal_periods TO legend_app;
--> statement-breakpoint
REVOKE UPDATE ON TABLE public.period_reopen_requests FROM legend_app;
--> statement-breakpoint
GRANT UPDATE (status, decided_by, decided_at, decision_note, updated_at)
  ON TABLE public.period_reopen_requests TO legend_app;
--> statement-breakpoint
-- Row guards for every role but the table owner. The application logs in as
-- legend_runtime_<hex>, a member of the NOLOGIN group legend_app, without SET
-- ROLE, so current_user is never the group name: the guard stands aside only
-- for the table owner (pattern of 0008). The reopen function is SECURITY
-- DEFINER owned by the migrator, so inside it current_user is the owner and its
-- consumed_at stamp passes; the migration owner is not restricted either.
CREATE FUNCTION app.assert_reopen_request_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF current_user = pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = TG_RELID)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending'
      OR NEW.decided_by IS NOT NULL
      OR NEW.decided_at IS NOT NULL
      OR NEW.consumed_at IS NOT NULL THEN
      RAISE EXCEPTION 'a reopen request starts pending and undecided (REOPEN_REQUEST_FORGED)'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'a decided reopen request cannot be changed (REOPEN_REQUEST_FORGED)'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status NOT IN ('approved', 'rejected', 'cancelled')
    OR NEW.consumed_at IS NOT NULL
    OR NEW.tenant_id <> OLD.tenant_id
    OR NEW.fiscal_period_id <> OLD.fiscal_period_id
    OR NEW.requested_by <> OLD.requested_by THEN
    RAISE EXCEPTION 'a pending reopen request only moves to approved, rejected or cancelled (REOPEN_REQUEST_FORGED)'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'approved' AND NEW.decided_by = NEW.requested_by THEN
    RAISE EXCEPTION 'a reopen request cannot be approved by its requester (REOPEN_SELF_APPROVAL)'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER period_reopen_requests_write_guard
BEFORE INSERT OR UPDATE ON public.period_reopen_requests
FOR EACH ROW EXECUTE FUNCTION app.assert_reopen_request_write();
