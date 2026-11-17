-- legend-hklnq (990 phase 5, contract A): a cleared reconciliation flag stays
-- cleared only while the flagged data does not change.
-- 1. payroll_payout_recon_flag_sightings (insert-only): each time the
--    reconciliation raises a flag, the fingerprint of the flagged data
--    (app.payout_recon_flag_fingerprint) is recorded when it differs from the
--    flag's current one (its latest sighting, by seen_at then id).
-- 2. payroll_payout_recon_clearances.flag_sha256: a clearance is bound to the
--    fingerprint it was proposed for; one clearance per flag and fingerprint.
-- 3. A flag holds its payslip back unless a clearance with the flag's LIVE
--    fingerprint (app.payout_recon_flag_fingerprint, EXECUTE granted to
--    legend_app) is approved: app.payout_payslip_held_by_recon and the API
--    slipsHeldByReconException call the same function, so data changed after
--    the approval holds the slip again at once, without waiting for a recon.
-- 4. app.payout_recon_flag (0432 body): after the insert (or the conflict on the
--    flag key) it records a sighting of the live fingerprint. Same key, other
--    data: a new sighting, and the old clearance no longer releases the slip.
-- 5. app.payout_recon_clear_propose (0581 body): binds the clearance to the live
--    fingerprint (recorded as a sighting first when new). An open clearance of
--    the same fingerprint returns its id; an approved one is PAYOUT-87.
-- 6. app.payout_recon_clear_approve (0581 body): the live fingerprint must be
--    the one of the clearance, else PAYOUT-91 (23514) and nothing changes (the
--    grant consumed in the function rolls back with it).
-- Fingerprint: sha256 (hex) of the jsonb text of {item, attestations, postings}:
-- the flagged item without updated_at, pii_key_version and the *_encrypted
-- columns (a key reseal must not reopen a flag); the attestations of the flag's
-- operation; the postings of the item (its gl_posting_id, or the posting whose
-- item set hash is the hash of this one item, as the overpaid posting), stripped
-- the same way. TimeZone is fixed to UTC so timestamps render the same in every
-- session.
-- Ownership: as 0581, the trusted functions are created by the payout role; the
-- table, its guard and the hold helper by the migrator.
CREATE TABLE "payroll_payout_recon_flag_sightings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"exception_id" uuid NOT NULL,
	"flag_sha256" varchar(64) NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_payout_recon_flag_sightings_sha_check" CHECK ("payroll_payout_recon_flag_sightings"."flag_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "payroll_payout_recon_flag_sightings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_recon_flag_sightings_exception_fk" FOREIGN KEY ("tenant_id","exception_id") REFERENCES "public"."payroll_payout_recon_exceptions"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "payroll_payout_recon_flag_sightings_exception_idx" ON "payroll_payout_recon_flag_sightings" USING btree ("tenant_id","exception_id","seen_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "payroll_payout_recon_clearances" DROP CONSTRAINT "payroll_payout_recon_clearances_exception_key";--> statement-breakpoint
-- Nullable until the backfill below fills a row left by 0580/0581 (none in
-- production: the table shipped one release ago); NOT NULL right after.
ALTER TABLE "payroll_payout_recon_clearances" ADD COLUMN "flag_sha256" varchar(64);--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payroll_payout_recon_flag_sightings'::regclass);
--> statement-breakpoint
-- enforce_tenant_rls hands legend_app full DML; this table is read-only to it.
REVOKE ALL ON TABLE public.payroll_payout_recon_flag_sightings FROM PUBLIC, legend_app;
--> statement-breakpoint
GRANT SELECT ON TABLE public.payroll_payout_recon_flag_sightings TO legend_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.payroll_payout_recon_flag_sightings TO legend_payout;
--> statement-breakpoint
-- A sighting is a record of what the reconciliation saw: never changed, never
-- erased (PAYOUT-87, 23514).
CREATE FUNCTION app.payroll_payout_recon_flag_sightings_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'PAYOUT-87: a reconciliation flag sighting cannot be changed or erased'
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER payroll_payout_recon_flag_sightings_row_guard_trg
  BEFORE UPDATE OR DELETE ON public.payroll_payout_recon_flag_sightings
  FOR EACH ROW EXECUTE FUNCTION app.payroll_payout_recon_flag_sightings_guard();
--> statement-breakpoint
CREATE TRIGGER payroll_payout_recon_flag_sightings_truncate_guard_trg
  BEFORE TRUNCATE ON public.payroll_payout_recon_flag_sightings
  FOR EACH STATEMENT EXECUTE FUNCTION app.payroll_payout_recon_flag_sightings_guard();
--> statement-breakpoint
GRANT legend_payout TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO legend_payout;
--> statement-breakpoint
SET ROLE legend_payout;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The fingerprint of the data behind a flag (null for a flag not in the
-- tenant). Read under tenant RLS as the payout role.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.payout_recon_flag_fingerprint(p_tenant uuid, p_exception uuid)
RETURNS varchar
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp SET timezone = 'UTC' AS $$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'item', (
        SELECT pg_catalog.jsonb_object_agg(f.key, f.value)
          FROM public.payroll_disbursement_items it,
               pg_catalog.jsonb_each(pg_catalog.to_jsonb(it)) AS f(key, value)
         WHERE it.tenant_id = e.tenant_id AND it.id = e.item_id
           AND f.key NOT IN ('updated_at', 'pii_key_version')
           AND f.key NOT LIKE '%\_encrypted'),
      'attestations', COALESCE((
        SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) ORDER BY a.id)
          FROM public.payroll_payout_attestations a
         WHERE a.tenant_id = e.tenant_id AND a.operation_id = e.operation_id),
        '[]'::jsonb),
      'postings', COALESCE((
        SELECT pg_catalog.jsonb_agg(
                 (SELECT pg_catalog.jsonb_object_agg(f.key, f.value)
                    FROM pg_catalog.jsonb_each(pg_catalog.to_jsonb(p)) AS f(key, value)
                   WHERE f.key NOT IN ('updated_at', 'pii_key_version')
                     AND f.key NOT LIKE '%\_encrypted')
                 ORDER BY p.id)
          FROM public.payroll_payout_gl_postings p
          JOIN public.payroll_disbursement_items it
            ON it.tenant_id = e.tenant_id AND it.id = e.item_id
         WHERE p.tenant_id = e.tenant_id
           AND (p.id = it.gl_posting_id
             OR p.item_set_hash = pg_catalog.encode(pg_catalog.sha256(
                  pg_catalog.convert_to(it.id::text, 'UTF8')), 'hex'))),
        '[]'::jsonb)
    )::text, 'UTF8')), 'hex')::varchar
    FROM public.payroll_payout_recon_exceptions e
   WHERE e.tenant_id = p_tenant AND e.id = p_exception
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_recon_flag_fingerprint(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
-- The hold helper and the batch guard read the live fingerprint as legend_app.
GRANT EXECUTE ON FUNCTION app.payout_recon_flag_fingerprint(uuid, uuid) TO legend_app;
--> statement-breakpoint
-- For the backfill below only (the migrator holds the payout role without
-- inheriting it); revoked again before the end of this migration.
GRANT EXECUTE ON FUNCTION app.payout_recon_flag_fingerprint(uuid, uuid) TO SESSION_USER;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Record the live fingerprint of a flag as a sighting when it is not the
-- flag's current one; returns the live fingerprint. Called by the trusted
-- functions below only (no EXECUTE for anyone else). Serialised per flag by a
-- transaction advisory lock (tenant and exception) taken before the last
-- sighting is read, so two sessions never both record the same new fingerprint
-- out of order.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.payout_recon_flag_see(p_tenant uuid, p_exception uuid)
RETURNS varchar
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_live varchar;
  v_last varchar;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'payout_recon_flag_see:' || p_tenant::text || ':' || p_exception::text, 0));
  v_live := app.payout_recon_flag_fingerprint(p_tenant, p_exception);
  IF v_live IS NULL THEN
    RAISE EXCEPTION 'PAYOUT-69: reconciliation flag not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT s.flag_sha256 INTO v_last
    FROM public.payroll_payout_recon_flag_sightings s
   WHERE s.tenant_id = p_tenant AND s.exception_id = p_exception
   ORDER BY s.seen_at DESC, s.id DESC
   LIMIT 1;
  IF v_last IS DISTINCT FROM v_live THEN
    INSERT INTO public.payroll_payout_recon_flag_sightings (
      tenant_id, exception_id, flag_sha256, seen_at)
    VALUES (p_tenant, p_exception, v_live, pg_catalog.clock_timestamp());
  END IF;
  RETURN v_live;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_recon_flag_see(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint

-- Nightly reconciliation flag: the 0432 body, then a sighting of the flagged
-- data. Signature and ACL stay.
CREATE OR REPLACE FUNCTION app.payout_recon_flag(
  p_tenant uuid, p_kind text, p_operation uuid, p_item uuid, p_reason text
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_payslip uuid;
  v_exception uuid;
BEGIN
  IF p_tenant IS DISTINCT FROM app.require_tenant_id() THEN
    RAISE EXCEPTION 'PAYOUT-68: a flag is raised in the tenant in force only'
      USING ERRCODE = '23514';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('correction', 'overpaid', 'return', 'posting_source', 'closure', 'resolve', 'bank_confirm', 'batch_approve')
    OR p_operation IS NULL OR p_reason IS NULL OR pg_catalog.btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'PAYOUT-68: the flag needs a kind, an operation and a reason'
      USING ERRCODE = '23514';
  END IF;
  SELECT i.payslip_id INTO v_payslip
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = p_tenant AND i.id = p_item;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-68: the flagged item is not an item of the tenant'
      USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.payroll_payout_recon_exceptions (
    tenant_id, kind, operation_id, item_id, payslip_id, reason, flagged_at)
  VALUES (
    p_tenant, p_kind, p_operation, p_item, v_payslip,
    pg_catalog.left(p_reason, 200), pg_catalog.statement_timestamp())
  ON CONFLICT ON CONSTRAINT payroll_payout_recon_exceptions_flag_key DO NOTHING
  RETURNING id INTO v_exception;
  IF v_exception IS NULL THEN
    SELECT e.id INTO v_exception
      FROM public.payroll_payout_recon_exceptions e
     WHERE e.tenant_id = p_tenant AND e.kind = p_kind AND e.operation_id = p_operation
       AND e.item_id = p_item AND e.reason = pg_catalog.left(p_reason, 200);
  END IF;
  PERFORM app.payout_recon_flag_see(p_tenant, v_exception);
END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Clearance, step one (0581 body): the clearance is bound to the live
-- fingerprint of the flag, recorded as a sighting first when it is new. An open
-- clearance of the same fingerprint returns its id (the reason stays as first
-- proposed); an approved one is PAYOUT-87.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.payout_recon_clear_propose(p_exception uuid, p_grant text, p_reason text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_batch uuid;
  v_grant uuid;
  v_actor text;
  v_session text;
  v_template text;
  v_id uuid;
  v_done timestamptz;
  v_sha varchar;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF p_reason IS NULL OR pg_catalog.char_length(pg_catalog.btrim(p_reason)) < 10
     OR pg_catalog.char_length(p_reason) > 500 THEN
    RAISE EXCEPTION 'PAYOUT-85: a clearance of a reconciliation flag needs a reason of 10 to 500 characters'
      USING ERRCODE = '23514';
  END IF;
  SELECT it.batch_id INTO v_batch
    FROM public.payroll_payout_recon_exceptions e
    JOIN public.payroll_disbursement_items it
      ON it.tenant_id = e.tenant_id AND it.id = e.item_id
   WHERE e.tenant_id = v_tenant AND e.id = p_exception;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-69: reconciliation flag not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT g.grant_id, g.actor, g.session_id INTO v_grant, v_actor, v_session
    FROM app.payout_grant_consume(v_tenant, p_grant, 'recon_clear', 'propose', v_batch,
           NULL, NULL, p_exception, NULL,
           pg_catalog.encode(pg_catalog.sha256(
             pg_catalog.convert_to(p_reason, 'UTF8')), 'hex')) AS g;
  PERFORM app.payout_assert_actor(v_tenant, v_actor, v_session, 'payroll.disburse.approve');
  SELECT r.template_key INTO v_template
    FROM public.role_assignments ra
    JOIN public.roles r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
   WHERE ra.tenant_id = v_tenant AND ra.user_id = v_actor
     AND ra.scope_type = 'tenant'
     AND ra.valid_from <= v_now
     AND (ra.valid_until IS NULL OR ra.valid_until > v_now)
     AND r.template_key IN ('owner', 'finance')
   LIMIT 1;
  IF v_template IS NULL THEN
    RAISE EXCEPTION 'PAYOUT-42: only a tenant-wide owner or finance role can clear a reconciliation flag'
      USING ERRCODE = '42501';
  END IF;
  v_sha := app.payout_recon_flag_see(v_tenant, p_exception);
  INSERT INTO public.payroll_payout_recon_clearances (
    tenant_id, exception_id, flag_sha256, reason, proposed_by, proposed_session_id, proposed_grant_id)
  VALUES (v_tenant, p_exception, v_sha, p_reason, v_actor, v_session, v_grant)
  ON CONFLICT ON CONSTRAINT payroll_payout_recon_clearances_exception_sha_key DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT c.id, c.approved_at INTO v_id, v_done
      FROM public.payroll_payout_recon_clearances c
     WHERE c.tenant_id = v_tenant AND c.exception_id = p_exception
       AND c.flag_sha256 = v_sha;
    IF v_done IS NOT NULL THEN
      RAISE EXCEPTION 'PAYOUT-87: the reconciliation flag is already cleared'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN v_id;
END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Clearance, step two (0581 body): the live fingerprint of the flag must be the
-- one the clearance was proposed for (PAYOUT-91); the sighting is brought up to
-- date so the approval releases the slip.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.payout_recon_clear_approve(p_clearance uuid, p_grant text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := app.require_tenant_id();
  v_batch uuid;
  v_reason text;
  v_grant uuid;
  v_actor text;
  v_session text;
  v_template text;
  v_row public.payroll_payout_recon_clearances%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  SELECT it.batch_id, c.reason INTO v_batch, v_reason
    FROM public.payroll_payout_recon_clearances c
    JOIN public.payroll_payout_recon_exceptions e
      ON e.tenant_id = c.tenant_id AND e.id = c.exception_id
    JOIN public.payroll_disbursement_items it
      ON it.tenant_id = e.tenant_id AND it.id = e.item_id
   WHERE c.tenant_id = v_tenant AND c.id = p_clearance;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-69: reconciliation clearance not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT g.grant_id, g.actor, g.session_id INTO v_grant, v_actor, v_session
    FROM app.payout_grant_consume(v_tenant, p_grant, 'recon_clear', 'approve', v_batch,
           NULL, NULL, p_clearance, NULL,
           pg_catalog.encode(pg_catalog.sha256(
             pg_catalog.convert_to(v_reason, 'UTF8')), 'hex')) AS g;
  PERFORM app.payout_assert_actor(v_tenant, v_actor, v_session, 'payroll.disburse.approve');
  SELECT r.template_key INTO v_template
    FROM public.role_assignments ra
    JOIN public.roles r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
   WHERE ra.tenant_id = v_tenant AND ra.user_id = v_actor
     AND ra.scope_type = 'tenant'
     AND ra.valid_from <= v_now
     AND (ra.valid_until IS NULL OR ra.valid_until > v_now)
     AND r.template_key IN ('owner', 'finance')
   LIMIT 1;
  IF v_template IS NULL THEN
    RAISE EXCEPTION 'PAYOUT-42: only a tenant-wide owner or finance role can clear a reconciliation flag'
      USING ERRCODE = '42501';
  END IF;
  SELECT c.* INTO v_row
    FROM public.payroll_payout_recon_clearances c
   WHERE c.tenant_id = v_tenant AND c.id = p_clearance
     FOR UPDATE;
  IF v_row.approved_at IS NOT NULL THEN
    RAISE EXCEPTION 'PAYOUT-87: the reconciliation clearance is already approved'
      USING ERRCODE = '23514';
  END IF;
  IF v_row.proposed_by = v_actor OR v_row.proposed_session_id = v_session THEN
    RAISE EXCEPTION 'PAYOUT-86: the proposer of a reconciliation clearance cannot approve it'
      USING ERRCODE = '42501';
  END IF;
  IF app.payout_recon_flag_fingerprint(v_tenant, v_row.exception_id)
       IS DISTINCT FROM v_row.flag_sha256 THEN
    RAISE EXCEPTION 'PAYOUT-91: the flagged data changed since the clearance was proposed'
      USING ERRCODE = '23514';
  END IF;
  PERFORM app.payout_recon_flag_see(v_tenant, v_row.exception_id);
  UPDATE public.payroll_payout_recon_clearances
     SET approved_by = v_actor, approved_session_id = v_session,
         approved_grant_id = v_grant, approved_at = v_now
   WHERE tenant_id = v_tenant AND id = p_clearance AND approved_at IS NULL;
  RETURN p_clearance;
END $$;
--> statement-breakpoint

RESET ROLE;
--> statement-breakpoint

-- (hklnq) a flag holds its payslip unless a clearance of the flag's LIVE
-- fingerprint is approved. Changed data after the approval: held again at once.
CREATE OR REPLACE FUNCTION app.payout_payslip_held_by_recon(p_tenant uuid, p_payslip uuid)
RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.payroll_payout_recon_exceptions e
     WHERE e.tenant_id = p_tenant AND e.payslip_id = p_payslip
       AND NOT EXISTS (
         SELECT 1
           FROM public.payroll_payout_recon_clearances c
          WHERE c.tenant_id = e.tenant_id AND c.exception_id = e.id
            AND c.approved_at IS NOT NULL
            AND c.flag_sha256 = app.payout_recon_flag_fingerprint(e.tenant_id, e.id)))
$$;
--> statement-breakpoint

-- Backfill: one sighting per flag that exists, and the fingerprint of its
-- flag on each clearance left by 0581, tenant by tenant (the fingerprint reads
-- under tenant RLS). The clearance guard refuses every update but approval, so
-- it is disabled for this statement only, in the migration transaction.
ALTER TABLE public.payroll_payout_recon_clearances DISABLE TRIGGER payroll_payout_recon_clearances_row_guard_trg;
--> statement-breakpoint
DO $$
DECLARE
  previous_tenant text := pg_catalog.current_setting('app.tenant_id', true);
  t record;
BEGIN
  FOR t IN SELECT id FROM public.tenants ORDER BY id LOOP
    PERFORM pg_catalog.set_config('app.tenant_id', t.id::text, true);
    INSERT INTO public.payroll_payout_recon_flag_sightings (tenant_id, exception_id, flag_sha256)
    SELECT e.tenant_id, e.id, app.payout_recon_flag_fingerprint(e.tenant_id, e.id)
      FROM public.payroll_payout_recon_exceptions e
     WHERE e.tenant_id = t.id;
    UPDATE public.payroll_payout_recon_clearances c
       SET flag_sha256 = s.flag_sha256
      FROM public.payroll_payout_recon_flag_sightings s
     WHERE c.tenant_id = t.id AND s.tenant_id = c.tenant_id
       AND s.exception_id = c.exception_id AND c.flag_sha256 IS NULL;
  END LOOP;
  PERFORM pg_catalog.set_config('app.tenant_id', COALESCE(previous_tenant, ''), true);
END $$;
--> statement-breakpoint
ALTER TABLE public.payroll_payout_recon_clearances ENABLE TRIGGER payroll_payout_recon_clearances_row_guard_trg;
--> statement-breakpoint
SET ROLE legend_payout;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.payout_recon_flag_fingerprint(uuid, uuid) FROM SESSION_USER;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM legend_payout;
--> statement-breakpoint
REVOKE SET OPTION FOR legend_payout FROM CURRENT_USER;
--> statement-breakpoint
ALTER TABLE "payroll_payout_recon_clearances" ALTER COLUMN "flag_sha256" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_payout_recon_clearances" ADD CONSTRAINT "payroll_payout_recon_clearances_exception_sha_key" UNIQUE("tenant_id","exception_id","flag_sha256");--> statement-breakpoint
ALTER TABLE "payroll_payout_recon_clearances" ADD CONSTRAINT "payroll_payout_recon_clearances_sha_check" CHECK ("payroll_payout_recon_clearances"."flag_sha256" ~ '^[0-9a-f]{64}$');
