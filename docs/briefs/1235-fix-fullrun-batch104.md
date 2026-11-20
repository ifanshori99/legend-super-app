# 1235 Perbaiki full run batch104 (4 gagal, 2 file)

Worktree `../legend-int-batch104` (int/batch104, sudah setup, log `.batch104-fullrun.log`). Typecheck hijau. Selain 4 ini semua hijau (27109 + 492 web + root).

1. `src/test/data-import-registry.test.ts` 3 gagal: berkas 1223 belum terdaftar — `apps/api/src/db/backfill-ptkp-history.ts`, `apps/api/src/services/payroll-ptkp-backfill.ts` (import/seed/backfill), migrasi 0519/0520 (INSERT/UPDATE belum di-acknowledge), dan Pool baru (cek pesan test). Ikuti pola registry: daftarkan di `DATA_IMPORT_SOURCES` + panggil `guardDataImport` di script backfill (atau NOT_A_WRITER dengan alasan yang benar), acknowledge migrasi. Jangan melonggarkan test.
2. `src/test/payroll-payout-990-recon-attest.test.ts` `[legend-r8nas-resolve-withdrawn-propose]`: dapat recon exception `attestation_count` pada resolve. Tenant id tetap `0b6f1c2e-...` — cek apakah flake (jalankan sendiri 3x) atau regresi dari 1229/1220/1223 (lock tahun pajak? payroll-run-reversal?). Akar masalah dulu. Kode salah -> perbaiki kode + test; isolasi data -> perbaiki fixture.
Jalankan `LEGEND_TEST_FILES="src/test/data-import-registry.test.ts src/test/payroll-payout-990-recon-attest.test.ts" heavy pnpm test` dari root, 2x. Typecheck api. Commit (`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`), push int/batch104. Budget 35 tool call; di 28 commit + lapor.
