# Brief: merge gelombang (gerbang founder Q3 + Q1, 2026-11-08)

Founder menyetujui merge ke `main`: `ws/db-role-provisioning` 4d08dac, `ws/fiscal-close-lock` bfe16fb, `ws/edge-hardening` 2536ec6, `ws/pos-payment-fixes` 2f68a5c, `ui/pos-kasir` 3f5c91e.

## Cara
- Worktree sementara: `git worktree add .worktrees/main-merge main` (repo `/Users/ifanshori99/Projects/legend super app/legend`). Setup: `pnpm install --offline --frozen-lockfile`; jangan symlink `node_modules`.
- Urutan: db-role → fiscal → edge-hardening → pos-payment-fixes → ui/pos-kasir. Tiap cabang `git merge --no-ff <cabang>`.
- Migration bentrok nomor (0063–0065 dipakai beberapa cabang): renumber per `HANDOFF.md` §5 lewat drizzle-kit, jangan edit `drizzle/meta/_journal.json` dengan tangan, jangan ubah isi SQL migration selain nomor/nama. Cek urutan migration tetap benar (edge 0063 harus jalan sebagai table owner biasa).
- Konflik kode di luar migration yang tidak jelas: berhenti, laporkan file dan sisi yang bentrok. Jangan tebak logika uang/auth.
- Setelah tiap merge: `heavy pnpm check` cepat bila bentrok; setelah merge terakhir wajib gerbang penuh: `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs`.
- Jangan push. Jangan hapus cabang. Jangan baca `.env*`.

## Laporan
SHA `main` akhir, merge commit per cabang, migration yang di-renumber (lama → baru), hasil gerbang (angka test), konflik yang tidak bisa diselesaikan.
