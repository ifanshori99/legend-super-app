# Brief 1104: engineer Codex, test flake (tingkat S, test saja)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md`, lalu ikuti. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (maks 6, satu per kartu).

## Aturan
- Worktree sendiri dari `milestone/m1`. Ubah hanya berkas test/fixture di `apps/api/src/test/`. Kode produk tidak disentuh; bila akar masalah ada di kode produk, berhenti dan lapor.
- Tanpa migrasi. Kamu tidak menjalankan `bd`; CTO memindah kartu.
- Test terarah lewat `heavy` (`LEGEND_TEST_FILES="..." heavy pnpm test`), dua berkas yang saling mencemari dijalankan bersama untuk bukti. Prettier/eslint berkas berubah.
- Push cabang tanpa `--force`.

## Grup A (cabang `ws/1104a-flake-api`)
- legend-whg2: `core-outbox-consumer.test.ts:230` relay setelah replay 0, harusnya 1.
- legend-52659: `payment-duitku-webhook.test.ts`, `payment-duitku-406-cancel.test.ts`, `payment-duitku-406-webhook.test.ts`, `payment-intent-expiry-worker.test.ts` gagal acak bersama (FK `payment_intents` -> `tenant_integrations` saat cleanup).
- legend-8i8ey: `rbac-audit-writer.test.ts` ZodError `actionType` di full run (baris test lain).

## Grup B (cabang `ws/1104b-flake-payroll`)
- legend-qm4t8: `payroll-ter-monthly.test.ts` duplikat kunci `statutory_rates` (`pph21_ter`, 2002-01-01).
- legend-rudky: `payroll-simulate-kit.ts` tanggal acak 1980-2019 bentrok dengan test tanggal tetap; kunci rentang atau tenant terpisah, lalu hapus workaround `TER_FROM` 1979.
- legend-jcznz: `payroll-payout-item-snapshot.test.ts` gagal bila akun acak berakhir 9999; cek apakah fix `int/batch73` sudah di m1 (bila ya, laporkan saja).

## Laporan
Per kartu: akar masalah, berkas, bukti (gagal sebelum / lulus sesudah, atau reproduksi), commit, head SHA. Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
