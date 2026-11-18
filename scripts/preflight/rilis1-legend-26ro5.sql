-- gate: legend-26ro5
-- before: none
-- requires: public.refund_recon_holds, public.payment_provider_refunds, public.payment_intents, public.payment_evidence, public.payment_refunds, public.payment_unallocated_funds
-- mode: block
-- resolve: Tahan rilis. Tidak ada alur resolve untuk hold yang sudah tertutup, dan matched_fact_id tidak boleh diubah langsung di DB tanpa persetujuan. Remedi: perbaikan data sekali pakai yang direview architect dan disetujui CTO dan finance, atau keputusan CTO mengubah gerbang ini ke mode info setelah run bersih pertama. Query gagal berarti rilis tetap ditahan.
-- Hold counted_against_intent yang ditutup lewat jalur rowOf sebelum 1126 dan
-- matched_fact_id-nya NULL: refund yang sama bisa terhitung ganda.
-- Hold bernama (ada refund id): terdaftar bila JUMLAH fact penyedia untuk
-- kuncinya (intent, kind, refund id, transaksi) kurang dari jumlah hold, satu
-- baris per hold. Fact yang dihitung memakai aturan cakupan 1119/1126
-- (refund-hold-coverage.ts): fact yang sudah diikat hold lain, fact yang
-- disebut hold counted lain dengan intent, kind, dan id yang sama (ref
-- transaksi sama atau NULL), dan fact echo refund kita sendiri
-- (ownRefundEchoesFactSql, disalin ke CTE e) tidak dihitung. Skema memberi
-- paling banyak satu fact per (tenant, provider, kind, id), jadi satu hold
-- bernama punya paling banyak satu fact. Hold tanpa transaksi (provider_payment_ref NULL) dicocokkan ke
-- fact kunci yang sama di transaksi mana pun (lebih longgar dari 1119 yang
-- menganggapnya tidak tercakup apa pun).
-- Hold anonim (refund id NULL): hanya finance yang bisa memasangkannya, dan
-- hanya ke fact kind provider. Terdaftar bila intent-nya punya fact kind
-- provider dan transaksi masih bersisa (sisa > 0, disederhanakan dari
-- transactionLeftIdr: evidence atau jumlah intent, dikurangi fact penyedia,
-- dikurangi refund kita yang selesai dan tidak di-echo, hanya bila hold itu
-- bertransaksi milik intent sendiri atau tanpa transaksi, seperti
-- ownCompletedIdrSql; cabang dana tak teralokasi tidak dihitung). Hold anonim yang ditutup tanpa fact karena sisa
-- <= 0 sah, begitu juga yang punya fact synthetic_hold miliknya sendiri.
-- Pengecualian sah lain: hold synthetic_full dan alasan
-- credit_used_before_provider_refund. Semua join dibatasi tenant. Keluaran
-- tanpa PII; nol baris = lolos.
WITH e AS (
  SELECT r.id AS refund_id, f.id AS fact_id
  FROM payment_refunds r
  JOIN payment_provider_refunds f
    ON f.tenant_id = r.tenant_id
   AND f.payment_intent_id = r.payment_intent_id
   AND f.refund_id_kind = 'provider'
   AND f.provider_refund_id = r.provider_ref
   AND r.amount_idr >= f.amount_idr
  WHERE r.status <> 'failed'
    AND (
      ((r.unallocated_fund_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM payment_unallocated_funds ef
          WHERE ef.tenant_id = r.tenant_id
            AND ef.id = r.unallocated_fund_id
            AND ef.evidence_id IS NOT NULL))
        AND EXISTS (
          SELECT 1 FROM payment_intents ri
          WHERE ri.tenant_id = r.tenant_id
            AND ri.id = r.payment_intent_id
            AND ri.provider_ref = f.provider_payment_ref))
      OR EXISTS (
        SELECT 1 FROM payment_unallocated_funds ff
        JOIN payment_evidence fe
          ON fe.tenant_id = ff.tenant_id AND fe.id = ff.evidence_id
        WHERE ff.tenant_id = r.tenant_id
          AND ff.id = r.unallocated_fund_id
          AND fe.provider = f.provider
          AND fe.provider_ref = f.provider_payment_ref))
),
c AS (
  SELECT h.tenant_id, h.id AS hold_id, h.payment_intent_id,
         h.provider_refund_id_kind AS kind, h.provider_refund_id,
         h.provider_payment_ref, h.amount_idr AS hold_idr,
         (h.provider_refund_id IS NULL) AS anonymous
  FROM refund_recon_holds h
  WHERE h.resolution = 'counted_against_intent'
    AND h.resolved_at IS NOT NULL
    AND h.matched_fact_id IS NULL
    AND h.reason <> 'credit_used_before_provider_refund'
    AND coalesce(h.provider_refund_id_kind, '') <> 'synthetic_full'
    AND NOT (h.provider_refund_id IS NULL AND EXISTS (
      SELECT 1 FROM payment_provider_refunds o
      WHERE o.tenant_id = h.tenant_id
        AND o.payment_intent_id = h.payment_intent_id
        AND o.refund_id_kind = 'synthetic_hold'
        AND o.provider_refund_id = h.id::text))
),
m AS (
  SELECT c.hold_id, f.id AS fact_id, f.amount_idr,
         EXISTS (
           SELECT 1 FROM refund_recon_holds b
           WHERE b.tenant_id = f.tenant_id
             AND b.id <> c.hold_id
             AND (b.matched_fact_id = f.id
                  OR (b.payment_intent_id = f.payment_intent_id
                      AND b.resolution = 'counted_against_intent'
                      AND b.resolved_at IS NOT NULL
                      AND b.provider_refund_id_kind = f.refund_id_kind
                      AND b.provider_refund_id = f.provider_refund_id
                      AND coalesce(b.provider_payment_ref,
                                   f.provider_payment_ref)
                          = f.provider_payment_ref))) AS shared,
         EXISTS (SELECT 1 FROM e WHERE e.fact_id = f.id) AS echo
  FROM c
  JOIN payment_provider_refunds f
    ON f.tenant_id = c.tenant_id
   AND f.payment_intent_id = c.payment_intent_id
   AND f.provider = 'doit'
   AND f.refund_id_kind = c.kind
   AND f.provider_refund_id = c.provider_refund_id
   AND (c.provider_payment_ref IS NULL
        OR f.provider_payment_ref = c.provider_payment_ref)
  WHERE NOT c.anonymous
),
a AS (
  SELECT c.*,
    (SELECT count(*) FROM m WHERE m.hold_id = c.hold_id) AS fact_count,
    coalesce((SELECT sum(m.amount_idr) FROM m
      WHERE m.hold_id = c.hold_id AND NOT m.shared AND NOT m.echo), 0)
      AS covered_idr,
    (SELECT count(*) FROM m WHERE m.hold_id = c.hold_id AND m.shared)
      AS shared_count,
    EXISTS (
      SELECT 1 FROM payment_provider_refunds pf
      WHERE pf.tenant_id = c.tenant_id
        AND pf.payment_intent_id = c.payment_intent_id
        AND pf.provider = 'doit'
        AND pf.refund_id_kind = 'provider') AS has_provider_fact,
    (coalesce(
        (SELECT sum(ev.amount_idr) FROM payment_evidence ev
          WHERE ev.tenant_id = c.tenant_id
            AND ev.payment_intent_id = c.payment_intent_id
            AND ev.provider = 'doit'
            AND ev.provider_ref = c.provider_payment_ref),
        (SELECT i.amount_idr FROM payment_intents i
          WHERE i.tenant_id = c.tenant_id AND i.id = c.payment_intent_id))
     - coalesce(
        (SELECT sum(p.amount_idr) FROM payment_provider_refunds p
          WHERE p.tenant_id = c.tenant_id
            AND p.payment_intent_id = c.payment_intent_id
            AND p.provider = 'doit'
            AND (c.provider_payment_ref IS NULL
                 OR p.provider_payment_ref = c.provider_payment_ref)), 0)
     - coalesce(
        (SELECT sum(o.amount_idr) FROM payment_refunds o
          WHERE o.tenant_id = c.tenant_id
            AND o.payment_intent_id = c.payment_intent_id
            AND o.status = 'completed'
            AND o.unallocated_fund_id IS NULL
            AND (c.provider_payment_ref IS NULL
                 OR c.provider_payment_ref = (
                   SELECT oi.provider_ref FROM payment_intents oi
                   WHERE oi.tenant_id = c.tenant_id
                     AND oi.id = c.payment_intent_id))
            AND NOT EXISTS (SELECT 1 FROM e WHERE e.refund_id = o.id)), 0)
    ) AS left_idr
  FROM c
)
SELECT a.tenant_id, a.hold_id, a.payment_intent_id, a.kind,
  a.provider_refund_id, a.hold_idr, a.fact_count, a.covered_idr,
  CASE WHEN a.anonymous OR a.fact_count = 0 THEN 'fact_unbound'
       WHEN a.shared_count > 0 THEN 'fact_shared'
       ELSE 'fact_below_hold' END AS problem
FROM a
WHERE (NOT a.anonymous AND a.covered_idr < a.hold_idr)
   OR (a.anonymous AND a.has_provider_fact
       AND (a.left_idr IS NULL OR a.left_idr > 0))
ORDER BY a.tenant_id, a.hold_id;
