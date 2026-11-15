# 885 rencana kerja (engineer QRIS hold)
Baca dulu: docs/briefs/885-qris-879-so-fix.md (keputusan CTO final) dan docs/qa/second-opinion-qris-879.md (temuan + test usulan) dan docs/briefs/so-879-qris-hold-fix.md (peta kode lama). Basis kode: fd4427fd1. Aturan: waktu lokal bukan bukti mati; ragu = tahan; uang tak boleh dobel. Migrasi baru dinomori 0628, 0629, 0630 (sementara; journal boleh loncat dari 0383; FK tabel baru inline di CREATE TABLE; FORCE RLS tanpa FK NOT VALID; data-import-registry.test.ts butuh entri bila migrasi punya INSERT/UPDATE; snapshot terakhir dibangun ulang dengan `pnpm db:generate` lalu pastikan generate berikutnya kosong). Test dari ROOT repo: `LEGEND_TEST_FILES="src/test/x.test.ts" heavy pnpm test`; jangan suite penuh, jangan pkill, jangan commit (koordinator yang commit). Test baru ditulis MERAH DULU (jalankan sebelum edit kode, lihat gagal), lalu kode, lalu hijau. prettier --write + eslint untuk berkas diubah. Lapor ringkas: berkas, merah->hijau, keraguan.

## Pemilik berkas (hindari tumpang tindih)
- Wave 1 paralel:
  - A (legend-m7tnt, P1 DP proof): payment-provider-proof.ts, reservation-lifecycle.ts (+ reservation-*.ts terkait), tes baru qris-hold-so885-a-*.test.ts
  - D (legend-adiov, P1 force release): pos-qris-hold.ts, tabel/migrasi 0628 antrean rekonsiliasi, worker baru + worker-main.ts, route daftar antrean staf, tes qris-hold-so885-d-*.test.ts
  - E+F (legend-05pjx, legend-m8jax): qr-order-consumers.ts, payment-refund.service.ts (+ route/alert), tes qris-hold-so885-e-*.test.ts
- Wave 2 (setelah wave 1): B (legend-tqkbb, P1 VA) + C (legend-0owye, P1 backfill failed): payment.service.ts, qr-order-payment.ts, bill-split.service.ts, drizzle/0381_pos_qris_holds.sql, migrasi 0629.
