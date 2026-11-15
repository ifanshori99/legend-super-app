# 868 Backend daftar rekonsiliasi EDC (engineer Sonnet, uang/akses)

Founder Q9 (15 Nov): layar rekonsiliasi EDC disetujui (gerbang B lulus). Cabang fix/edc-recon-list-868 dari ui/edc-rekonsiliasi-865 (593b4fb33/5fb5f8273).
Kartu legend-p98qi (bd show). Kontrak usulan sudah ada: `listEdcReconciliationQueue` di packages/shared/src/payment/admin.ts, saat ini hanya mock.
- Endpoint GET daftar sesuai kontrak: transaksi kartu yang ditandai + baris unknown tanpa flag (setelah 10 menit sejak sale dikirim; sebelum itu tampil terkunci), bukti/jejak terminal, saleWireOpenAt, aksi yang diizinkan per status (sama dengan aturan POST /edc/transactions/:id/reconciliation di payment-admin.routes.ts:201).
- Akses: requireAuth, requireTrustedOrigin tidak perlu untuk GET, requirePermission payment.reconcile; filter tenant + outlet yang boleh dilihat di SQL. Pagination dengan skema strict.
- Ganti mock web ke API nyata (features api/queries/hooks); e2e mock tetap hijau.
Test gagal-dulu: isolasi tenant/outlet, role tanpa payment.reconcile 403, baris unknown <10 menit terkunci, aksi per status cocok dengan POST, tidak ada data kartu sensitif (PAN penuh) di respons.
Review: satu subagent architect effort xhigh (uang/akses). Pra-gate AGENTS.md (typecheck api + web lewat heavy). Commit + push tanpa force. Lapor sha, test, review, angka subagent.
