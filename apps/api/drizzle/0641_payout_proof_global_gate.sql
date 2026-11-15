ALTER TABLE "payroll_payout_proof_backfill_stuck" DROP CONSTRAINT "payroll_payout_proof_backfill_stuck_reason_check";--> statement-breakpoint
ALTER TABLE "payroll_payout_proof_backfill_stuck" ADD COLUMN "operations" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_payout_proof_backfill_stuck" ADD CONSTRAINT "payroll_payout_proof_backfill_stuck_reason_check" CHECK ("payroll_payout_proof_backfill_stuck"."reason" IN ('unreadable', 'hash_conflict', 'legacy_duplicate', 'shared_key', 'bind_failed'));--> statement-breakpoint
-- legend-p2v4s (second opinion 897), F1 and F2: the proof backfill gate is
-- global, and one SQL source of truth names every proof operation.
-- F2: app.payout_proof_operations() lists, for the current tenant (RLS), every
-- operation a proof backs: return claims, item returns from before the claims
-- (pre-0381, no claim row), failed-item corrections and overpaid (batch, key)
-- groups. Its item_set_hash equals itemSetHashOf in the services (lowercase
-- uuids sorted bytewise, joined by a newline, SHA-256 hex). An operation is
-- ACCOUNTED when a binding of its key exists and either names the same
-- operation (kind, batch, item set) or holds a contested hash; two operations
-- on one key leave one of them unaccounted until the backfill contests the key
-- (app.payout_proof_contest_own) and lists it as stuck (reason shared_key, the
-- new `operations` column).
-- F1: app.payout_proof_tenant_pending() is true while the current tenant has
-- a return claim without a hash, a proof record without its stored hash, an
-- item proof key without a record, or an unaccounted operation.
-- app.payout_proof_history_pending() asks the same of every tenant (FORCE RLS:
-- it sets the tenant of each in turn, pattern 0187, and restores the caller's)
-- and answers one boolean, so a tenant waits on another one's history without
-- learning which tenant, batch or proof.
CREATE OR REPLACE FUNCTION app.payout_proof_operations()
RETURNS TABLE (
  kind varchar,
  batch_id uuid,
  item_set_hash varchar,
  evidence_key varchar,
  content_sha256 varchar,
  stored_sha256 varchar,
  first_at timestamp with time zone,
  created_by text
)
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  -- Returns: the claim carries the item set hash.
  SELECT 'return'::varchar, c.batch_id, c.item_set_hash, c.evidence_key,
         f.content_sha256, f.stored_sha256, c.created_at, c.created_by
    FROM public.payroll_payout_return_claims c
    LEFT JOIN public.payroll_payout_evidence_files f
      ON f.tenant_id = c.tenant_id AND f.evidence_key = c.evidence_key
   WHERE c.tenant_id = app.require_tenant_id()
  UNION ALL
  -- Item returns without a claim (pre-0381): the items of one batch that share
  -- the proof key are one operation.
  SELECT 'return'::varchar, i.batch_id,
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
           pg_catalog.string_agg(i.id::text, E'\n' ORDER BY i.id::text COLLATE "C"),
           'UTF8')), 'hex')::varchar,
         i.return_evidence_key, f.content_sha256, f.stored_sha256,
         pg_catalog.min(i.created_at),
         pg_catalog.min(COALESCE(i.returned_by, i.returned_by_2, 'legacy-backfill'))
    FROM public.payroll_disbursement_items i
    LEFT JOIN public.payroll_payout_evidence_files f
      ON f.tenant_id = i.tenant_id AND f.evidence_key = i.return_evidence_key
   WHERE i.tenant_id = app.require_tenant_id()
     AND i.return_evidence_key IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM public.payroll_payout_return_claims c
        WHERE c.tenant_id = i.tenant_id AND c.evidence_key = i.return_evidence_key)
   GROUP BY i.batch_id, i.return_evidence_key, f.content_sha256, f.stored_sha256
  UNION ALL
  -- Corrections: the first row of a request holds the proof and its hashes; the
  -- items are the rows that share its operation id.
  SELECT 'correction'::varchar, r.batch_id,
         (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
                   pg_catalog.string_agg(o.item_id::text, E'\n' ORDER BY o.item_id::text COLLATE "C"),
                   'UTF8')), 'hex')::varchar
            FROM public.payroll_payout_failed_corrections o
           WHERE o.tenant_id = r.tenant_id AND o.operation_id = r.id),
         r.evidence_key, r.content_sha256, r.stored_sha256, r.proposed_at,
         r.proposed_by
    FROM public.payroll_payout_failed_corrections r
   WHERE r.tenant_id = app.require_tenant_id()
     AND r.operation_id = r.id
  UNION ALL
  -- Overpaid: the proposals of one batch that share a proof are one operation.
  SELECT 'overpaid'::varchar, p.batch_id,
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
           pg_catalog.string_agg(p.item_id::text, E'\n' ORDER BY p.item_id::text COLLATE "C"),
           'UTF8')), 'hex')::varchar,
         p.evidence_key, f.content_sha256, f.stored_sha256,
         pg_catalog.min(p.proposed_at),
         (pg_catalog.array_agg(p.proposed_by ORDER BY p.proposed_at, p.id))[1]
    FROM public.payroll_payout_overpaid_proposals p
    LEFT JOIN public.payroll_payout_evidence_files f
      ON f.tenant_id = p.tenant_id AND f.evidence_key = p.evidence_key
   WHERE p.tenant_id = app.require_tenant_id()
   GROUP BY p.batch_id, p.evidence_key, f.content_sha256, f.stored_sha256
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payout_proof_tenant_pending() RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT EXISTS (
           SELECT 1
             FROM public.payroll_payout_return_claims c
            WHERE c.tenant_id = app.require_tenant_id()
              AND (c.content_sha256 IS NULL OR c.stored_sha256 IS NULL))
      OR EXISTS (
           SELECT 1
             FROM public.payroll_payout_evidence_files f
            WHERE f.tenant_id = app.require_tenant_id()
              AND f.stored_sha256 IS NULL)
      OR EXISTS (
           SELECT 1
             FROM public.payroll_disbursement_items i
            CROSS JOIN LATERAL (VALUES
              (i.resolution_evidence_key),
              (i.confirmation_evidence_key),
              (i.return_evidence_key)) AS k(evidence_key)
            WHERE i.tenant_id = app.require_tenant_id()
              AND k.evidence_key IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                  FROM public.payroll_payout_evidence_files f
                 WHERE f.tenant_id = i.tenant_id
                   AND f.evidence_key = k.evidence_key))
      OR EXISTS (
           SELECT 1
             FROM app.payout_proof_operations() o
            WHERE NOT EXISTS (
              SELECT 1
                FROM public.payroll_payout_proof_bindings b
               WHERE b.tenant_id = app.require_tenant_id()
                 AND b.evidence_key = o.evidence_key
                 AND ((b.kind = o.kind
                       AND b.batch_id = o.batch_id
                       AND b.item_set_hash = o.item_set_hash)
                      OR app.payout_proof_contested(
                           ARRAY[b.content_sha256, b.stored_sha256]::varchar[]))))
$$;
--> statement-breakpoint
-- SECURITY DEFINER: the owner is still bound by FORCE RLS, so it sets each
-- tenant in turn (a local setting, restored at the end). STABLE: one snapshot
-- for the whole loop. Answers one boolean and nothing else.
CREATE OR REPLACE FUNCTION app.payout_proof_history_pending() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  previous_tenant text := pg_catalog.current_setting('app.tenant_id', true);
  tenant uuid;
  pending boolean := false;
BEGIN
  FOR tenant IN SELECT t.id FROM public.tenants t ORDER BY t.id LOOP
    PERFORM pg_catalog.set_config('app.tenant_id', tenant::text, true);
    IF app.payout_proof_tenant_pending() THEN
      pending := true;
      EXIT;
    END IF;
  END LOOP;
  PERFORM pg_catalog.set_config('app.tenant_id', COALESCE(previous_tenant, ''), true);
  RETURN pending;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.payout_proof_history_pending() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_proof_history_pending() TO legend_app;
--> statement-breakpoint
-- F2: the backfill found more than one operation under a key of the caller's
-- tenant. Records the non-empty hashes of that key's binding (read under the
-- caller's tenant policy) as contested, so every step of every operation over
-- those bytes, in any tenant, is refused (409 PAYOUT_PROOF_REUSED). SECURITY
-- DEFINER (owner of the contest table, which is not FORCED); the caller can
-- only contest bytes its own tenant has bound. A key without a binding is
-- refused, never skipped.
CREATE OR REPLACE FUNCTION app.payout_proof_contest_own(p_key varchar) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  bound record;
BEGIN
  SELECT b.content_sha256, b.stored_sha256
    INTO bound
    FROM public.payroll_payout_proof_bindings b
   WHERE b.tenant_id = app.require_tenant_id()
     AND b.evidence_key = p_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-38: payout proof key has no binding to contest'
      USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.payroll_payout_proof_hash_contests (sha256, contested_at)
  SELECT DISTINCT h, pg_catalog.statement_timestamp()
    FROM unnest(ARRAY[bound.content_sha256, bound.stored_sha256]::varchar[]) AS h
   WHERE h <> 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  ON CONFLICT (sha256) DO NOTHING;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.payout_proof_contest_own(varchar) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_proof_contest_own(varchar) TO legend_app;
