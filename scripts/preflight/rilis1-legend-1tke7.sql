-- gate: legend-1tke7
-- before: none
-- requires: public.payroll_payout_gl_postings
-- mode: block
-- resolve: Finance menyelesaikan baris yang tercantum secara manual dulu (settle_pending: selesaikan settle-nya; settle_skipped tunai: waive resmi dengan alasan; settle_skipped bank: jalankan catch-up jurnal), lalu jalankan ulang gerbang; jangan mengisi settle_net_idr langsung di DB.
-- Posting payout GL legacy yang belum punya settle_net_idr dan masih
-- settle_pending atau settle_skipped: jumlah settle-nya hanya tersegel, jadi
-- tidak bisa dipakai otomatis dan harus diselesaikan finance dulu. Kolom
-- settle_net_idr dibaca lewat to_jsonb(p), bukan sebagai nama kolom, supaya
-- SQL tetap jalan di DB yang kolomnya belum ada; di DB itu kuncinya tidak ada
-- dan hasilnya nol baris (N/A, lolos). Kunci ada dengan nilai null berarti
-- baris legacy. Keluaran hanya id, tenant, batch, dan kind; nol baris berarti
-- lolos.
SELECT
  p.tenant_id,
  p.id AS posting_id,
  p.batch_id,
  p.kind
FROM payroll_payout_gl_postings p
WHERE p.kind IN ('settle_pending', 'settle_skipped')
  AND jsonb_typeof(to_jsonb(p) -> 'settle_net_idr') = 'null'
ORDER BY p.tenant_id, p.id;
