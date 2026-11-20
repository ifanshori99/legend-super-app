# 1224 UI batalkan persetujuan distribusi bagi hasil (syarat gerbang rilis)

Cabang `ws/1217-distribusi-reopen` (worktree `/Users/ifanshori99/Projects/legend super app/legend-1217`), sesudah engineer API selesai (CTO memberi tahu). Ikuti `~/.agents/team/ui-standard.md`. Web + teks katalog saja; API sudah ada: `POST /distributions/:id/cancel-approved` (alasan wajib). Aturan umum test/commit: `docs/briefs/1217-1220-fix-so1216.md`.

- Dialog "Batalkan persetujuan" (alasan min 10 karakter) hanya untuk pemegang izin approve distribusi; tampil di run approved yang belum ada uang keluar. Pola dialog: cari dialog konfirmasi beralasan yang sudah ada di fitur distribusi/payroll.
- Pesan jelas untuk `DISTRIBUTION_HAS_ADJUSTMENT` (batalkan penyesuaiannya dulu), `DISTRIBUTION_PARTIALLY_PAID`, dan di layar buka ulang periode untuk `PERIOD_HAS_APPROVED_DISTRIBUTION` (arahkan ke run yang perlu dibatalkan).
- Lencana "Perlu koreksi" mengarah ke aksi ini.
- Teks ke katalog (`node --test tests/text-contract.test.mjs`), prettier/eslint, `heavy pnpm --filter @starter/web typecheck`, test web yang ada untuk fitur ini bila ada. Screenshot 390 dan 1280 bila dev server tersedia (lewat heavy --browser), simpan di `docs/review/img/`. Budget 35 tool call. Commit + push, lapor SHA.
