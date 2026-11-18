-- gate: legend-9bfh7
-- before: 0395_payout_proof_bindings
-- requires: public.payroll_payout_return_claims, public.payroll_disbursement_items, public.payroll_payout_failed_corrections, public.payroll_payout_overpaid_proposals, public.payroll_payout_evidence_files
-- mode: block
-- resolve: Give each listed payout operation its own proof, with an evidence record whose content and stored hashes are complete and match the operation, and settle each listed upload record without a stored hash or return claim with a missing hash by hand, before 0395, so the proof binding backfill and the 0399 gate do not stop; each id reads as <reason>:<kind>.
WITH ops AS (
  SELECT c.tenant_id, 'return'::text AS kind, c.batch_id, c.evidence_key, c.id AS ref_id,
         (f.evidence_key IS NOT NULL) AS has_record,
         (f.evidence_key IS NOT NULL AND f.stored_sha256 IS NULL) AS stored_missing,
         (f.evidence_key IS NOT NULL
          AND ((c.content_sha256 IS NOT NULL AND c.content_sha256 IS DISTINCT FROM f.content_sha256)
               OR (c.stored_sha256 IS NOT NULL AND f.stored_sha256 IS NOT NULL
                   AND c.stored_sha256 IS DISTINCT FROM f.stored_sha256))) AS record_mismatch,
         ARRAY[f.content_sha256, f.stored_sha256, c.content_sha256, c.stored_sha256]::text[] AS shas
    FROM payroll_payout_return_claims c
    LEFT JOIN payroll_payout_evidence_files f
      ON f.tenant_id = c.tenant_id AND f.evidence_key = c.evidence_key
  UNION ALL
  SELECT i.tenant_id, 'return'::text, i.batch_id, i.return_evidence_key,
         (array_agg(i.id ORDER BY i.id))[1],
         (f.evidence_key IS NOT NULL),
         (f.evidence_key IS NOT NULL AND f.stored_sha256 IS NULL),
         false,
         ARRAY[f.content_sha256, f.stored_sha256]::text[]
    FROM payroll_disbursement_items i
    LEFT JOIN payroll_payout_evidence_files f
      ON f.tenant_id = i.tenant_id AND f.evidence_key = i.return_evidence_key
   WHERE i.return_evidence_key IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM payroll_payout_return_claims c
        WHERE c.tenant_id = i.tenant_id AND c.evidence_key = i.return_evidence_key)
   GROUP BY i.tenant_id, i.batch_id, i.return_evidence_key,
            f.evidence_key, f.content_sha256, f.stored_sha256
  UNION ALL
  SELECT r.tenant_id, 'correction'::text, r.batch_id, r.evidence_key, r.id,
         (f.evidence_key IS NOT NULL),
         (f.evidence_key IS NOT NULL AND f.stored_sha256 IS NULL),
         (f.evidence_key IS NOT NULL
          AND (f.content_sha256 IS DISTINCT FROM r.content_sha256
               OR f.stored_sha256 IS DISTINCT FROM r.stored_sha256)),
         ARRAY[f.content_sha256, f.stored_sha256, r.content_sha256, r.stored_sha256]::text[]
    FROM payroll_payout_failed_corrections r
    LEFT JOIN payroll_payout_evidence_files f
      ON f.tenant_id = r.tenant_id AND f.evidence_key = r.evidence_key
   WHERE r.operation_id = r.id
  UNION ALL
  SELECT p.tenant_id, 'overpaid'::text, p.batch_id, p.evidence_key,
         (array_agg(p.id ORDER BY p.id))[1],
         (f.evidence_key IS NOT NULL),
         (f.evidence_key IS NOT NULL AND f.stored_sha256 IS NULL),
         false,
         ARRAY[f.content_sha256, f.stored_sha256]::text[]
    FROM payroll_payout_overpaid_proposals p
    LEFT JOIN payroll_payout_evidence_files f
      ON f.tenant_id = p.tenant_id AND f.evidence_key = p.evidence_key
   GROUP BY p.tenant_id, p.batch_id, p.evidence_key,
            f.evidence_key, f.content_sha256, f.stored_sha256
  UNION ALL
  -- Payment proofs (confirmation and resolution keys of items): only compared
  -- by hash with the operations above; reported only for a missing record or stored hash.
  SELECT i.tenant_id, 'confirmation'::text, i.batch_id, k.evidence_key,
         (array_agg(i.id ORDER BY i.id))[1],
         (f.evidence_key IS NOT NULL),
         (f.evidence_key IS NOT NULL AND f.stored_sha256 IS NULL),
         false,
         ARRAY[f.content_sha256, f.stored_sha256]::text[]
    FROM payroll_disbursement_items i
   CROSS JOIN LATERAL (VALUES
     (i.confirmation_evidence_key),
     (i.resolution_evidence_key)) AS k(evidence_key)
    LEFT JOIN payroll_payout_evidence_files f
      ON f.tenant_id = i.tenant_id AND f.evidence_key = k.evidence_key
   WHERE k.evidence_key IS NOT NULL
   GROUP BY i.tenant_id, i.batch_id, k.evidence_key,
            f.evidence_key, f.content_sha256, f.stored_sha256
),
op_ident AS (
  SELECT o.*,
         o.tenant_id::text || '|' || o.kind || '|' || o.batch_id::text || '|' || o.evidence_key AS ident
    FROM ops o
),
op_shas AS (
  SELECT DISTINCT o.ident, s.sha
    FROM op_ident o
   CROSS JOIN LATERAL unnest(o.shas) AS s(sha)
   WHERE s.sha IS NOT NULL
     AND s.sha <> 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
),
shared_sha AS (
  SELECT sha FROM op_shas GROUP BY sha HAVING count(DISTINCT ident) > 1
),
problems AS (
  SELECT o.tenant_id, 'hash_shared_across_operations'::text AS reason, o.kind, o.ref_id
    FROM op_ident o
   WHERE o.kind <> 'confirmation'
     AND EXISTS (
       SELECT 1 FROM op_shas s JOIN shared_sha h ON h.sha = s.sha WHERE s.ident = o.ident)
  UNION
  SELECT o.tenant_id, 'shared_key_operations'::text, o.kind, o.ref_id
    FROM op_ident o
   WHERE o.kind <> 'confirmation'
     AND EXISTS (
       SELECT 1 FROM op_ident x
        WHERE x.kind <> 'confirmation'
          AND x.tenant_id = o.tenant_id AND x.evidence_key = o.evidence_key
          AND x.ident <> o.ident)
  UNION
  SELECT o.tenant_id, 'missing_evidence_record'::text, o.kind, o.ref_id
    FROM op_ident o
   WHERE o.kind <> 'confirmation' AND NOT o.has_record
  UNION
  SELECT o.tenant_id, 'missing_stored_hash'::text, o.kind, o.ref_id
    FROM op_ident o
   WHERE o.stored_missing
  UNION
  -- An upload record without a stored hash that no operation above reports
  -- (nothing refers to it): the 0413 pending test still counts it.
  SELECT f.tenant_id, 'missing_stored_hash'::text, 'file'::text, f.id
    FROM payroll_payout_evidence_files f
   WHERE f.stored_sha256 IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM op_ident o
        WHERE o.tenant_id = f.tenant_id AND o.evidence_key = f.evidence_key
          AND o.stored_missing)
  UNION
  -- A return claim with a NULL hash: the record comparison skips the NULL,
  -- but the 0413 pending test counts the claim whatever its upload record says.
  SELECT c.tenant_id, 'claim_hash_missing'::text, 'return'::text, c.id
    FROM payroll_payout_return_claims c
   WHERE c.content_sha256 IS NULL OR c.stored_sha256 IS NULL
  UNION
  SELECT o.tenant_id, 'record_hash_mismatch'::text, o.kind, o.ref_id
    FROM op_ident o
   WHERE o.kind <> 'confirmation' AND o.record_mismatch
  UNION
  SELECT o.tenant_id, 'payment_proof_without_record'::text, o.kind, o.ref_id
    FROM op_ident o
   WHERE o.kind = 'confirmation' AND NOT o.has_record
)
SELECT tenant_id, reason || ':' || kind AS reason, count(*)::bigint AS row_count,
       array_agg(ref_id ORDER BY ref_id) AS ids
  FROM problems
 GROUP BY tenant_id, reason, kind
 ORDER BY tenant_id, reason, kind;
