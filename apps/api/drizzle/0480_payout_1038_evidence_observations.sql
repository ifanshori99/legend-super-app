-- 1038 finding 4 (second opinion on 1036, bead legend-63gyr): a clearance of an
-- evidence flag (evidence_missing, evidence_hash_mismatch) must not outlive the
-- evidence problem it was approved for. The flag key and the 0464 fingerprint did
-- not see what the reconciliation read from the proof file, so mismatch A cleared,
-- then different wrong bytes B (or A again after a recovery), kept the old
-- clearance releasing the slip.
-- 1. payroll_payout_recon_evidence_observations (insert-only): what the
--    reconciliation observed of one operation's proof file: missing, mismatch (with
--    the sha256 of the bytes read) or ok (recovery). One row per change; episode
--    counts the problem runs.
-- 2. app.payout_recon_evidence_observe (payout role, trusted, EXECUTE to
--    legend_app like app.payout_recon_flag): records a row only when the state or
--    bytes differ from the operation's last observation; an ok is recorded only
--    after an earlier observation.
-- 3. app.payout_recon_flag_fingerprint (0464 body): an operation with a non-ok
--    observation adds the key "evidence" (state, observed_sha256, episode and seq
--    of its latest non-ok observation, latest by seq) to the fingerprinted object; an operation with none
--    keeps the 0464 object byte for byte, so no fingerprint changes without a
--    problem. A recovery does not change the fingerprint (the slip stays free); a
--    problem B, or A again, does: every new problem row has a new seq (identity,
--    taken under the per-operation lock, so it is the observation order, not the
--    clock), hence A, B, A without a recovery never returns the fingerprint of the
--    first A. The observe function can only add rows, so it can hold a slip, never
--    release one (the old clearance stops matching until a new two-person clearance).
-- Flags cleared before this migration have no observation: the first one recorded
-- adds the evidence key and reopens them once (fail closed).
-- Ownership as 0464: table, guard and RLS by the migrator, trusted functions by
-- the payout role.
CREATE TABLE "payroll_payout_recon_evidence_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "payroll_payout_recon_evidence_observations_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1) NOT NULL,
	"operation_id" uuid NOT NULL,
	"state" varchar(8) NOT NULL,
	"observed_sha256" varchar(64),
	"episode" integer NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_payout_recon_evidence_observations_state_check" CHECK ("payroll_payout_recon_evidence_observations"."state" IN ('missing', 'mismatch', 'ok')),
	CONSTRAINT "payroll_payout_recon_evidence_observations_sha_check" CHECK ("payroll_payout_recon_evidence_observations"."observed_sha256" IS NULL OR "payroll_payout_recon_evidence_observations"."observed_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "payroll_payout_recon_evidence_observations_episode_check" CHECK ("payroll_payout_recon_evidence_observations"."episode" >= 1),
	CONSTRAINT "payroll_payout_recon_evidence_observations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "payroll_payout_recon_evidence_observations_operation_idx" ON "payroll_payout_recon_evidence_observations" USING btree ("tenant_id","operation_id","seq" DESC NULLS LAST);--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payroll_payout_recon_evidence_observations'::regclass);
--> statement-breakpoint
-- enforce_tenant_rls hands legend_app full DML; this table is read-only to it.
REVOKE ALL ON TABLE public.payroll_payout_recon_evidence_observations FROM PUBLIC, legend_app;
--> statement-breakpoint
GRANT SELECT ON TABLE public.payroll_payout_recon_evidence_observations TO legend_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.payroll_payout_recon_evidence_observations TO legend_payout;
--> statement-breakpoint
-- An observation is a record of what the reconciliation saw: never changed, never
-- erased (PAYOUT-87, 23514).
CREATE FUNCTION app.payroll_payout_recon_evidence_observations_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'PAYOUT-87: a reconciliation evidence observation cannot be changed or erased'
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER payroll_payout_recon_evidence_observations_row_guard_trg
  BEFORE UPDATE OR DELETE ON public.payroll_payout_recon_evidence_observations
  FOR EACH ROW EXECUTE FUNCTION app.payroll_payout_recon_evidence_observations_guard();
--> statement-breakpoint
CREATE TRIGGER payroll_payout_recon_evidence_observations_truncate_guard_trg
  BEFORE TRUNCATE ON public.payroll_payout_recon_evidence_observations
  FOR EACH STATEMENT EXECUTE FUNCTION app.payroll_payout_recon_evidence_observations_guard();
--> statement-breakpoint
GRANT legend_payout TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO legend_payout;
--> statement-breakpoint
SET ROLE legend_payout;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Record what the reconciliation observed of the proof file of an operation.
-- Serialised per operation by a transaction advisory lock taken before the last
-- observation is read. Returns nothing; a no-change call writes nothing.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.payout_recon_evidence_observe(
  p_tenant uuid, p_operation uuid, p_state text, p_observed_sha text
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_last_state text;
  v_last_sha text;
  v_last_episode integer;
  v_episode integer;
BEGIN
  IF p_tenant IS DISTINCT FROM app.require_tenant_id() THEN
    RAISE EXCEPTION 'PAYOUT-68: an observation is recorded in the tenant in force only'
      USING ERRCODE = '23514';
  END IF;
  IF p_operation IS NULL OR p_state IS NULL OR p_state NOT IN ('missing', 'mismatch', 'ok')
    OR (p_state = 'mismatch' AND (p_observed_sha IS NULL OR p_observed_sha !~ '^[0-9a-f]{64}$'))
    OR (p_state <> 'mismatch' AND p_observed_sha IS NOT NULL) THEN
    RAISE EXCEPTION 'PAYOUT-68: the observation needs an operation, a state and, for a mismatch, the sha256 read'
      USING ERRCODE = '23514';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'payout_recon_evidence_observe:' || p_tenant::text || ':' || p_operation::text, 0));
  SELECT o.state, o.observed_sha256, o.episode
    INTO v_last_state, v_last_sha, v_last_episode
    FROM public.payroll_payout_recon_evidence_observations o
   WHERE o.tenant_id = p_tenant AND o.operation_id = p_operation
   ORDER BY o.seq DESC
   LIMIT 1;
  IF NOT FOUND THEN
    IF p_state = 'ok' THEN
      RETURN;
    END IF;
    v_episode := 1;
  ELSE
    IF v_last_state = p_state AND v_last_sha IS NOT DISTINCT FROM p_observed_sha THEN
      RETURN;
    END IF;
    v_episode := CASE WHEN v_last_state = 'ok' THEN v_last_episode + 1 ELSE v_last_episode END;
  END IF;
  INSERT INTO public.payroll_payout_recon_evidence_observations (
    tenant_id, operation_id, state, observed_sha256, episode, observed_at)
  VALUES (p_tenant, p_operation, p_state, p_observed_sha, v_episode,
          pg_catalog.clock_timestamp());
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_recon_evidence_observe(uuid, uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_recon_evidence_observe(uuid, uuid, text, text) TO legend_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The fingerprint of the data behind a flag (0464 body), plus the latest
-- non-ok evidence observation of the flag's operation when there is one. Signature,
-- owner and ACL stay.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.payout_recon_flag_fingerprint(p_tenant uuid, p_exception uuid)
RETURNS varchar
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp SET timezone = 'UTC' AS $$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    (pg_catalog.jsonb_build_object(
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
    ) || COALESCE((
        SELECT pg_catalog.jsonb_build_object('evidence', pg_catalog.jsonb_build_object(
                 'state', o.state,
                 'observed_sha256', o.observed_sha256,
                 'episode', o.episode,
                 'seq', o.seq))
          FROM public.payroll_payout_recon_evidence_observations o
         WHERE o.tenant_id = e.tenant_id AND o.operation_id = e.operation_id
           AND o.state <> 'ok'
         ORDER BY o.seq DESC
         LIMIT 1),
        '{}'::jsonb))::text, 'UTF8')), 'hex')::varchar
    FROM public.payroll_payout_recon_exceptions e
   WHERE e.tenant_id = p_tenant AND e.id = p_exception
$$;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM legend_payout;
--> statement-breakpoint
REVOKE SET OPTION FOR legend_payout FROM CURRENT_USER;
