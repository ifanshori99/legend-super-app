# Brief: second-opinion — shift kasir POS (legend-6c0)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/pos-shift`, cabang `ws/pos-shift` 69ddb9a4, digabung ke `milestone/m1` lewat `prep/pos-shift` SHA `1eda3a4b` (merge m1 `30a31a3c`, migration diregen jadi 0088-0090).
Rentang diff: `git diff 71751c8f 30a31a3c` (isi cabang saja di atas m1; abaikan drizzle `meta/*.json`). Jangan pakai `merge-base main`: menyeret isi m1 lain.

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
