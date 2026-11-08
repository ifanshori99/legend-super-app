# Brief: second-opinion — shift kasir POS (legend-6c0)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` dan `~/.agents/team/TEAM.md`. Read-only: jangan ubah kode, jangan commit. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/pos-shift`, cabang `ws/pos-shift` (HEAD `3e0855c`). Diff: `git diff main...ws/pos-shift` (abaikan snapshot drizzle `meta/*.json` yang besar).

## Fokus (area uang)
- Buka shift dengan modal awal; cash in/out dengan alasan; tidak bisa tercatat di shift yang sudah tutup.
- Blind count per pecahan: kasir tidak melihat ekspektasi sebelum submit; total dihitung server dari pecahan; nilai integer IDR; tidak bisa diulang/diubah setelah submit tanpa approval.
- Variance: rumus benar (modal + tunai masuk − keluar − kembalian vs hitungan), ambang dan approval supervisor sekali pakai, tidak bisa lintas shift/outlet/tenant.
- Tutup hari bisnis oleh manajer outlet, cutoff 04.00 waktu outlet: transaksi 00.00–03.59 masuk hari sebelumnya; tidak bisa tutup hari bila ada shift terbuka; idempoten.
- Race: transaksi tunai/cash in-out bersamaan dengan tutup shift atau tutup hari (lock, isolasi, tidak ada transaksi yang lolos ke shift tertutup atau hilang dari rekap).
- RLS dan permission: `0064_pos_shift_rls.sql`, `0065_pos_day_close_permission.sql`; isolasi tenant/outlet; role yang benar.
- Migration `0063_warm_speed_demon`, `0064`, `0065`: aman untuk data lama. Nomor akan bentrok dengan cabang lain dan dirapikan saat merge; itu bukan temuan.
- Test benar-benar membuktikan klaim. Boleh reproduksi dengan DB sementara (`~/.claude/scripts/colima-up`), bersihkan sesudahnya.

## Laporan
Temuan urut paling berat: file:baris, masalah, skenario gagal konkret, fix. "Tidak ada blocker" bila memang tidak ada.
