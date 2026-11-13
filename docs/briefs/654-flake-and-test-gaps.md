# Brief: engineer — flake suite penuh + celah test (test-only)

Peran: baca `~/.agents/team/roles/engineer.md`. Model Sonnet. Retro 26: delapan flake di batch58 makan 74 menit lajur merge train.

## Repo
Worktree dari `milestone/m1` (ea399bb4d): `git worktree add .worktrees/flake-654 -b fix/flaky-654 milestone/m1`, lalu `pnpm worktree:setup`. Tanpa migrasi.

## Kartu (file terpisah, satu implementer per kartu, paralel)
1. `legend-1jxh8`: `rotate-data-key` PAY-06 (2 tes) dan `hris-leave-changed-event` F5 (3 tes) timeout 20 dtk di run penuh, lulus sendiri. Cari akar (tunggu polling, sleep, lock), betulkan di test atau helper; jangan hanya menaikkan timeout kecuali terbukti beban murni.
2. `platform-org-api` TEN-03/06: ZodError `openingHours` bila jalan setelah berkas lain (bergantung urutan, juga muncul di batch57). Cari state bersama (seed, cache, singleton config) dan isolasi. Buat bead bila belum ada.
3. `legend-rr0x1`: `e2e/legend-zueb.mock.spec.ts:55` `getByText('Karyawan aktif')` cocok 2 elemen; pakai locator spesifik (role/testid).
4. `legend-30dhj`: test baru THR run dengan piutang PPh21 terbuka: tagih maks sisa ruang setelah THR, net >= 0, sisa piutang tetap terbuka; scheme mismatch tetap ditolak. Kode produksi tidak diubah; bila test membuktikan bug uang, berhenti dan lapor CTO.

## Bukti selesai
Tiap berkas yang dibetulkan lulus 3x berturut lewat `heavy` (test terarah), plus sekali bersama 10-20 berkas tetangga untuk meniru beban. Prettier + eslint. `bd update <id> --status review` + `bd comment`. Push tanpa force.

## Review
Tingkat S: satu subagent `reviewer` sonnet (kartu 4: `architect` effort high karena uang).

## Batas
Jangan merge, deploy, `pkill`, `pnpm test` penuh. Maks 4 subagent bersamaan.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
