# Brief: reviewer — payroll/HRIS: verifikasi dan tutup (tanpa kode baru)

## Peran
Baca `~/.agents/team/roles/reviewer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti.

## Worktree
Worktree Ghostex milikmu (base `milestone/m1`). Langkah 0: `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`. Tanpa migrasi (0714-0715 tidak dipakai).

## Kartu
1. `legend-s5c1`: buktikan selesai di m1. Builder `buildPph21Prior` mengisi `taxAllowanceIdr`/`grossSchemeBaseIdr`/`employerSchemeBaseIdr` (`packages/shared/src/hris/payroll/payslip-tax.ts:120-128`). Run lock memanggil `lockPayrollRunTax` (`apps/api/src/services/payroll-run-lock.service.ts:580`). Jalankan `payroll-pph21-december-runs.test.ts` (kasus gross/gross_up/net), `payroll-pph21-prior.test.ts`, `payroll-pph21-prior-reference.test.ts`. Hijau: `bd close` dengan bukti. Ada celah: tulis test merah, lapor, jangan perbaiki.
2. `legend-l5tvy`: perbaikan 0ac8e3b7c sudah di m1. Jalankan test terarah dari commit itu, lalu `bd close` dengan bukti.

## Aturan
- `legend-qhqf8` dan `legend-wxvt9` adalah ops (production/staging). Jangan jalankan skrip backfill ke DB bersama. Cukup cek bahwa runbook `docs/ops/hris-manager-backfill.md` dan skrip `payroll:backfill-pph21-receivable --dry-run` masih cocok dengan m1. Hasilnya `bd comment` saja.
- Uang (s5c1): pastikan ada assert bahwa karyawan gross-up tidak dibebani kekurangan pajak yang ditanggung perusahaan dan tidak menerima refund pajak tanggungan perusahaan. Bila assert itu tidak ada, itulah celahnya.

## Pembagian paralel
- Explore (1): peta test untuk s5c1 dan l5tvy.
- test-runner: pemegang token heavy (test terarah sekali).

## Bukti selesai
Test terarah lulus, `bd close` s5c1 dan l5tvy dengan perintah + hasil, komentar di qhqf8/wxvt9.

## Batas kerja ulang
Ikuti `~/.agents/team/brief-template.md` bagian "Batas kerja ulang". Jangan `pkill`.

## Sebelum melapor
Tanpa commit kecuali test merah celah s5c1 (cabang `ws/1099-verifikasi-payroll`).

## Laporan
Status per kartu, perintah test + hasil, celah bila ada.
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
