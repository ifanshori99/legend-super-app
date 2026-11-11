# 532 Fix temuan architect 531: refund POS, pay-admin, HRIS (tingkat K, uang)

Peran: engineer (~/.agents/team/roles/engineer.md), Sonnet. Satu putaran fix. Sumber temuan: laporan thread G82h6 (brief 531), disalin di bawah. Keputusan sudah diambil CTO; jangan tanya ulang.
Aturan uang founder: tiap fix uang dibuktikan test bahwa tidak ada pihak dibayar lebih dan outlet tidak rugi.

Cabang dan worktree (commit lokal di cabang masing-masing, jangan merge antar cabang, jangan push ke main):
- ws/pos-refund-ceilings -> .worktrees/pos-refund-ceilings
- ws/ws05-pay-admin -> .worktrees/ws05-pay-admin
- ws/hris-manager-backfill -> .worktrees/hris-manager-backfill
Migrasi baru: rentang 0340-0344 saja; `when` harus lebih besar dari semua migrasi di 0328-0334.

A. ws/pos-refund-ceilings
1. P1 uang `apps/api/src/services/pos-order-corrections.ts:200-330` voidPosOrderCorrection: pasang `refundApprovalWithinLimit` (amountIdr = voidCashIdr, penyetuju override.approvedBy), tolak di edge (Q67), dan `loadDeferredRefundCommitments`. Keputusan CTO: void tunai = jalur refund, kena batas Q63 kumulatif (founder dikonfirmasi lewat Q1 CTO baru; bila founder menolak, CTO memberi tahu). Test: void Rp200.001 oleh Supervisor ditolak; void di edge ditolak; refund edge tertunda Rp150rb lalu void Rp300rb ditolak/dibatasi sehingga total tunai keluar <= dibayar.
2. P2 `pos-order-corrections.ts:845-848` + `payment-refund-approval-limits.ts:270-287`: `committed` kecualikan refund kelebihan bayar dan refund terlambat (LATE_PAYMENT_REFUND_KEY_PREFIXES), batasi ke intent tender pesanan ini. Test: QRIS 100rb, kelebihan 20rb sudah direfund, refund POS 100rb lolos; refund POS 100rb+1 tetap ditolak.
3. P3-b `payment-refund-edge-history.ts:331-338`: saring lewat aggregate_type='order' + aggregate_id.
4. P3-a peran custom batas 0: biarkan perilaku (aman), tambah catatan rilis di docs/release-notes (atau PROGRESS) untuk cek data production.

B. ws/ws05-pay-admin
1. P1 performa `payment-refund-approval-limits.ts:82,138` (join :33,:39): ambil group key intent dulu, cari intent terkait lewat kolom ber-index, index `(tenant_id, payment_intent_id)` di orders dan pos_order_tenders (migrasi di rentang di atas). Bukti: EXPLAIN pada seed 50 ribu intent, hasil sama dengan sebelum (test hasil batas tidak berubah).
2. P2 `packages/shared/src/access/approval.ts:146-150`: matriks refund bawaan level 1 = supervisor, outlet_manager, general_manager, owner (sesuai Q63; meniru cash_shift_close), seed + migrasi data. Test: refund 1jt disetujui outlet_manager lolos, oleh supervisor ditolak.
3. P3 refund kelebihan bayar menghabiskan batas: biarkan (lebih ketat).
Catatan: A dan B sama-sama menyentuh payment-refund-approval-limits.ts di dua cabang. Kerjakan berurutan atau samakan logika agar merge train tidak konflik; catat di laporan.

C. ws/hris-manager-backfill (P3, kecil)
1. `hris-employee-manager.service.ts:162/:179`: panggil lagi mayChangeEmployeeManager setelah baris dikunci.
2. `backfill-employee-managers.ts:569-577`: FOR SHARE pada role_assignments calon atasan.
3. `backfill-employee-managers.ts:169`: buang ﻿ di awal CSV.

Paralel: Explore per cabang, satu implementer per cabang (A, B, C bisa jalan bersamaan; worktree terpisah), test-writer untuk test fail-first A1/A2/B2, test-runner per cabang. Test terarah lewat `LEGEND_TEST_FILES=... heavy pnpm test`; tsc lewat heavy.
Selesai: tiap fix punya test gagal-dulu lalu lulus, tsc paket api/shared lulus, satu `reviewer` sonnet atas diff fix tiap cabang. Laporan: commit per cabang, test, angka subagent.
