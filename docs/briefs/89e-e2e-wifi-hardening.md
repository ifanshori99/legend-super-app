# Brief 89e: prep e2e-az dan ws09-wifi-hardening (merge train m1)

Aturan umum: ikuti `89a-merge-prep.md` dan `89b-migration-regen.md`. Jangan push, jangan merge ke milestone/m1, jangan pkill/killall, jangan baca .env. Commit lokal, akhiri dengan `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Tes terarah tanpa heavy: `LEGEND_TEST_FILES="src/test/a.test.ts ..." pnpm test` dari root worktree. Jangan `pnpm check` penuh. `pnpm -s format:check` harus bersih.

## A. e2e-az
- Worktree `.worktrees/prep-e2e-az`, cabang `prep/e2e-az`. Merge `ws/e2e-az` c01e9c63 (bila belum), lalu `milestone/m1` 726515a4 (berisi pos-receipt, whitelabel, ws02).
- Unskip skenario pos-receipt (`describeUntilMerged` → `describe` untuk pos-receipt; sebelumnya di az-e:1301, az-r:338/342; cari nama cabang `pos-receipt`). EDC-01/02/04 tetap skip (legend-dahk/m4fv).
- Jalankan e2e-az: `heavy pnpm test:e2e` dengan filter spek e2e-az (lihat package.json / playwright config untuk cara filter file `e2e/az-*`). Laporkan lulus/skip/gagal per skenario. Gagal karena tes: jangan betulkan logika produk; laporkan.

## B. ws09-wifi-hardening
- Sumber `ws/ws09-wifi-hardening` d2710c47 (di atas ws/ws09-wifi b9d7e40b). Buat worktree `.worktrees/prep-ws09-wifi-hardening`, cabang `prep/ws09-wifi-hardening` dari d2710c47, `pnpm worktree:setup`.
- Merge `prep/ws09-wifi` 76121e6a (migrasi wifi sudah 0103/0104). `drizzle/meta/*` ambil sisi prep.
- Regen migrasi hardening 0101/0102 menjadi nomor setelah 0104 (`when` lebih besar), custom SQL ke `--custom`, pola NO FORCE/FORCE untuk FK ke tabel FORCE RLS. Perbaiki referensi nama lama di tes.
- Typecheck, tes terarah wifi (`src/test/*wifi*`) dan tes yang disentuh hardening. Commit.

## Laporan
SHA, migrasi baru + `when`, hasil tes, yang belum diverifikasi.
