-- gate: legend-1tke7
-- before: none
-- requires: public.payroll_payout_gl_postings
-- mode: info
-- resolve: Finance menyelesaikan baris yang tercantum secara manual dulu (settle_pending: selesaikan settle-nya; settle_skipped tunai: waive resmi dengan alasan; settle_skipped bank: jalankan catch-up jurnal), lalu jalankan ulang gerbang; jangan mengisi settle_net_idr langsung di DB.
-- Posting payout GL legacy yang belum punya settle_net_idr dan masih
-- settle_pending atau settle_skipped: jumlah settle-nya hanya tersegel, jadi
-- tidak bisa dipakai otomatis dan harus diselesaikan finance dulu. Kolom
-- settle_net_idr dibaca lewat to_jsonb(p) ->> 'settle_net_idr', bukan sebagai
-- nama kolom, supaya SQL tidak error di DB yang kolomnya belum ada. Kunci yang
-- hilang dan nilai NULL sama-sama menghasilkan NULL, jadi dua-duanya dianggap
-- baris legacy dan diblok (aturan membatasi: ragu berarti gagal, bukan lolos).
-- Keluaran hanya id, tenant, batch, dan kind; nol baris berarti lolos.
SELECT
  p.tenant_id,
  p.id AS posting_id,
  p.batch_id,
  p.kind
FROM payroll_payout_gl_postings p
WHERE p.kind IN ('settle_pending', 'settle_skipped')
  AND (to_jsonb(p) ->> 'settle_net_idr') IS NULL
ORDER BY p.tenant_id, p.id;
