-- legend-i01jp (905 fixer 4): the nightly recon cannot read the global
-- payroll_payout_proof_hashes (no privilege for the app role, 0395). A forger
-- with owner rights who rewrites a claimed hash frees the proof for a second
-- binding while the binding row and the file still match. This read-only
-- SECURITY DEFINER helper (owner of the hash table, like
-- app.payout_proof_contested in 0398) answers one boolean: every non-empty hash
-- of the binding of this key, in the tenant in force, is still held by that
-- binding. No row is written, no amount touched.
CREATE OR REPLACE FUNCTION app.payout_proof_hashes_held(p_key varchar) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT NOT EXISTS (
    SELECT 1
      FROM public.payroll_payout_proof_bindings b
     CROSS JOIN LATERAL unnest(ARRAY[b.content_sha256, b.stored_sha256]::varchar[]) AS h(sha)
     WHERE b.tenant_id = app.require_tenant_id()
       AND b.evidence_key = p_key
       AND NOT b.legacy_duplicate
       AND h.sha <> 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
       AND NOT EXISTS (
         SELECT 1 FROM public.payroll_payout_proof_hashes ph
          WHERE ph.sha256 = h.sha AND ph.binding_id = b.id)
  )
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.payout_proof_hashes_held(varchar) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_proof_hashes_held(varchar) TO legend_app;
