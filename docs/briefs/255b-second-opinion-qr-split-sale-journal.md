# 255b Codex second-opinion: jurnal penjualan QR split bill (legend-gzu54) — JANGAN dijalankan sebelum antrean Codex

Cabang `ws/qr-split-sale-journal` (worktree `.worktrees/qr-split-sale-journal`), rentang `ff571dc9..190f906c` (lanjutan `ws/journal-split-guard`, legend-05cm9; area refund QR/jurnal: gabungkan dengan 240b bila satu sesi). Tingkat K (uang, akuntansi), effort xhigh. Read-only.

Berkas berisiko:
- `apps/api/src/services/accounting-auto-journal-amounts.ts` (`qrSaleGatewayOf`, `qrSaleSharesOf` baru, ~543-700).
- `apps/api/src/services/accounting-auto-journal-guards.ts` (`intentBackedAt` blok qrSales ~770-815, `assertSaleWithinReceipt`): tidak diubah di cabang ini, tetapi harus konsisten dengan bagian per intent.
- Test: `apps/api/src/test/accounting-auto-journal-split-qr-sale.test.ts` (SALE-1..7), `accounting-auto-journal-split-qr-guard.test.ts` (SPLIT-S1..S5).

Invariant:
1. Debit customer_deposit + debit gateway_clearing sebuah sale QR = total - DP; withReceipt = min(total-DP, jumlah bagian kontributor dengan receipt posted).
2. Bagian kontributor = min(total-DP, evidence - unallocated funds); payer tunggal (tidak ada intent lain beralokasi > 0 di link) = total-DP penuh dan tetap wajib `amount_idr >= total-DP`.
3. Ada receipt kontributor pending: sale parkir RECEIPT_PENDING (retryable) lalu terposting setelah receipt; jumlah bagian < total-DP: PAYLOAD_INVALID non-retryable.
4. Tiap kontributor posted diperiksa `assertSaleWithinReceipt` pada bound sale dengan bagian yang sama dengan guard payout (tidak ada false mismatch, tidak ada fail-open).
5. Order non-split berperilaku sama (AJ-QR-01..17).
Risiko untuk dicek: alokasi dibaca tanpa kunci intent (evidence/fund yang datang sesudah fire); kontributor EDC/intent hilang (fail closed); fund payer tanpa receipt sendiri meninggalkan sisa di customer_deposit (SALE-7, -50k) apakah penjurnalan fund yang benar; guard refund menahan payer penuh sementara guard jurnal menahan bagiannya (disengaja).
