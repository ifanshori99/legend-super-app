# Brief: second-opinion — shift kasir POS (legend-6c0)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/pos-shift`, cabang `ws/pos-shift`, SHA `580d0db`.
Rentang diff: `git diff $(git merge-base main 580d0db)..580d0db` (abaikan drizzle `meta/*.json`).

## Berkas berisiko
- `apps/api/src/services/pos-shift.service.ts`
- `apps/api/src/services/pos-shift-support.ts`
- `apps/api/src/services/pos-shift-ports.ts`
- `apps/api/src/services/pos-day.service.ts`
- `apps/api/src/routes/pos-shift.routes.ts`
- `apps/api/drizzle/0063_warm_speed_demon.sql`, `0064_pos_shift_rls.sql`, `0065_pos_day_close_permission.sql`, `0066_pos_shift_counts.sql`, `0067_pos_shift_counts_rls.sql`

## Invariant (PRD)
- POS-02: void, diskon di atas ambang, dan refund tidak bisa tanpa approval yang sah, selalu tercatat dengan alasan.
- POS-03: tutup shift memakai blind count. Selisih kas tidak bisa disembunyikan atau diubah setelah disetujui.
- POS-04: transaksi final tidak bisa dihapus.
- U9: 100% shift ditutup. Setiap selisih punya penjelasan dan persetujuan.
- ACC-02: transaksi di periode tertutup ditolak kecuali periode dibuka ulang dengan approval.
- Shift Kasir: modal awal, kas masuk dan keluar dengan alasan, laporan selisih, approval supervisor.

## Effort
xhigh.

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
