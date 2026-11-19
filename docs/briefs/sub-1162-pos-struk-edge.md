# Sub-brief 1162 POS struk dan edge reporter

Cabang: ws/1162-pos-struk-edge (base milestone/m1). Tanpa migrasi. Tingkat K (uang struk, sinkron offline).

## Kartu dan berkas milik
- A. legend-gdjpu: ACK void edge mendahului ingest sukses. Berkas: apps/api/src/services/edge-receipt-run-reporter.ts, apps/api/src/worker/edge-order-redrive.job.ts. Rincian: /private/tmp/claude-501/so-1111.md (salinan docs/qa/second-opinion-pos-edge-1111.md dari commit 797a48706, bagian P2 baris 15-32).
- B. legend-rh1hk: laporan pull restore-detect membawa kursor outbox link. Berkas: pos-receipt.service.ts, pos-receipt.ts (schema), reporter. SETELAH A (berkas bertumpuk).
- C. legend-j772n: bucket DP di kontrak dokumen receipt/invoice. Berkas: packages/shared/src/pos/schemas.ts (checkDocumentTotals; perubahan kecil, aditif), renderer struk (pos-receipt-document.ts, pos-receipt-pdf.ts, pos-receipt-edge-print.ts bila perlu).
- D. legend-vet9d: pos-day.service.ts. MENUNGGU kabar CTO batch95 landing.

## Invarian
- Tanpa migrasi. Jangan sentuh order-given.ts, payment-admin.service.ts, accounting-journal*, cabang ghostex/eb4d9add.
- DP tidak dihitung dua kali, DP bukan cash (tidak ada kas semu). Total struk seimbang.
- Test gagal-dulu per kartu, terarah: LEGEND_TEST_FILES="src/test/x.test.ts" pnpm test. ID bertipe brand pakai helper.
