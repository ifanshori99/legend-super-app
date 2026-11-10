# Brief 89f: prep fix-edc-codex (merge train m1, prioritas P1)

Aturan umum: ikuti `89a-merge-prep.md` dan `89b-migration-regen.md`. Jangan push, jangan merge ke milestone/m1, jangan pkill/killall, jangan baca .env. Commit lokal, akhiri `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Tes terarah tanpa heavy: `LEGEND_TEST_FILES="src/test/a.test.ts ..." pnpm test` dari root worktree. Jangan `pnpm check` penuh. `pnpm -s format:check` bersih.

- Sumber `ws/fix-edc-codex` 164fa725 (basis m1 13425b65). Buat worktree `.worktrees/prep-fix-edc-codex`, cabang `prep/fix-edc-codex` dari 164fa725, `pnpm worktree:setup`.
- Merge `milestone/m1` 726515a4 (m1 sekarang sampai migrasi 0102). `drizzle/meta/*` ambil sisi m1.
- Migrasi cabang `0099_pos_override_edc_standalone.sql` dan `0100_edc_standalone_permission.sql` ditulis tangan. Ganti nomor menjadi 0103 dan 0104: rename file, tambahkan entri journal dengan `when` lebih besar dari 0102 (pola entri custom yang sudah ada), snapshot mengikuti cara 89b (`drizzle-kit generate --custom` lalu salin isi SQL, atau sesuai pola cabang). Pastikan `pnpm db:generate` setelahnya melaporkan tanpa perubahan. Perbaiki referensi nama lama di kode/tes.
- Verifikasi typecheck, tes EDC dan override (`src/test/*edc*`, `*override*`, `pos-order*.test.ts`) dan tes migrasi (`*migration*.test.ts`). Commit.
- Laporan: SHA, migrasi baru + `when`, hasil tes, yang belum diverifikasi.
