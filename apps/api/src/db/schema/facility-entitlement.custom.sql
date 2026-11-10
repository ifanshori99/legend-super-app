-- Hand SQL for entitlement_ledger (bead legend-fjk5; PRD v1.7 §3 F25 "Produk &
-- Hak Akses", §6 K; FAC-04, FAC-05). Appended to
-- drizzle/0215_facility_entitlement_ledger.sql. Foreign keys are inline in the
-- generated DDL (the migrator is not a superuser).

-- TEN-01, TEN-03: tenant-owned and outlet-owned (outlet_id NOT NULL).
SELECT app.enforce_tenant_rls('public.entitlement_ledger'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.entitlement_ledger'::regclass);
--> statement-breakpoint
-- FAC-05: the ledger is append-only. A trigger (not only a privilege) also
-- blocks the owner and the migrator (pattern 0203 point_ledger). A grant is
-- ended by a `cancel` or `expire` row, never by an edit.
CREATE FUNCTION app.reject_entitlement_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'entitlement_ledger is append-only (FAC-05)' USING ERRCODE = '42501';
END $$;
--> statement-breakpoint
CREATE TRIGGER entitlement_ledger_append_only
BEFORE UPDATE OR DELETE ON public.entitlement_ledger
FOR EACH ROW EXECUTE FUNCTION app.reject_entitlement_ledger_mutation();
--> statement-breakpoint
CREATE TRIGGER entitlement_ledger_no_truncate
BEFORE TRUNCATE ON public.entitlement_ledger
FOR EACH STATEMENT EXECUTE FUNCTION app.reject_entitlement_ledger_mutation();
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.reject_entitlement_ledger_mutation() FROM PUBLIC;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.entitlement_ledger FROM legend_app;
--> statement-breakpoint
-- FAC-05: second line of defence against double redemption. A redeem, cancel
-- or expire row locks its grant (one transaction at a time per grant), checks
-- that the grant exists for the same customer and facility, and refuses the
-- row when it would draw down more sessions than the grant has left. The
-- service takes a wider lock first; this holds even for a caller that does not.
CREATE FUNCTION app.entitlement_ledger_guard_draw_down() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_sessions integer;
  v_customer uuid;
  v_facility uuid;
  v_used bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(NEW.grant_entry_id::text));
  SELECT g.sessions, g.customer_profile_id, g.facility_id
    INTO v_sessions, v_customer, v_facility
    FROM public.entitlement_ledger g
   WHERE g.tenant_id = NEW.tenant_id
     AND g.id = NEW.grant_entry_id
     AND g.type = 'grant';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entitlement grant not found' USING ERRCODE = '23503';
  END IF;
  IF v_customer <> NEW.customer_profile_id OR v_facility <> NEW.facility_id THEN
    RAISE EXCEPTION 'entitlement row does not match its grant (customer or facility)'
      USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(sum(d.sessions), 0) INTO v_used
    FROM public.entitlement_ledger d
   WHERE d.tenant_id = NEW.tenant_id
     AND d.grant_entry_id = NEW.grant_entry_id;
  IF v_sessions - v_used < NEW.sessions THEN
    RAISE EXCEPTION 'entitlement overdraw: % left, % requested', v_sessions - v_used, NEW.sessions
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER entitlement_ledger_draw_down_guard
BEFORE INSERT ON public.entitlement_ledger
FOR EACH ROW WHEN (NEW.type <> 'grant')
EXECUTE FUNCTION app.entitlement_ledger_guard_draw_down();
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.entitlement_ledger_guard_draw_down() FROM PUBLIC;
