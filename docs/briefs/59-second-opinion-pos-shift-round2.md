# Brief: second-opinion — shift kasir POS putaran 2 (legend-6c0) — PRIORITAS

## Peran
Baca `~/.agents/team/roles/second-opinion.md` dan `~/.agents/team/TEAM.md`. Read-only: jangan ubah kode, jangan commit. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/pos-shift`, cabang `ws/pos-shift` (HEAD `580d0db`). Diff: `git diff main...ws/pos-shift` (abaikan snapshot drizzle `meta/*.json` yang besar). Konteks: `docs/PROGRESS.md` bagian "Serah terima CTO (2026-11-08 ±19:50)". Temuan putaran 1 ada di `docs/briefs/24-second-opinion-pos-shift.md`; perbaikannya di `docs/briefs/46-fix-pos-shift-round2.md`.

## Fokus (area uang, wajib diverifikasi ulang)
- Lima temuan putaran 1 benar-benar tertutup: (1) hari yang sudah ditutup tidak bisa menerima pesanan/bayar/void/refund di `pos-day.service.ts`; (2) tender tunai terikat shift aktif dan memakai lock shift yang sama dengan close; (3) approval variance terikat nilai selisih dan fingerprint hitungan pecahan; (4) pengajuan hitungan pertama immutable, angka berubah butuh approval baru; (5) tutup hari diblokir selama ada shift aktif, termasuk shift lintas cutoff 04.00.
- Kontrak baru: close memakai `countId`; endpoint baru `.../shifts/:shiftId/counts`; tunai wajib shift terbuka, gagal dengan 409 `SHIFT_NOT_OPEN`. Cek tidak ada jalur lama yang bisa melewati `countId` atau tunai di shift tertutup.
- Race: dua transaksi tunai atau tunai dengan close bersamaan. Lock terambil konsisten, tidak ada deadlock, tidak ada transaksi lolos ke shift tertutup atau hilang dari rekap.
- Variance: rumus server (modal + tunai masuk − keluar − kembalian vs hitungan), integer IDR, tidak bisa lintas shift, outlet, atau tenant. Approval sekali pakai.
- Blind count: kasir tidak melihat ekspektasi sebelum submit; total dihitung server; hitungan tidak bisa diubah diam-diam.
- Tutup hari bisnis, cutoff 04.00 waktu outlet; idempoten bila diulang.
- RLS dan permission: `0064_pos_shift_rls.sql`, `0065_pos_day_close_permission.sql`, plus migration `0066` dan `0067` (cek isinya di `apps/api/drizzle`). Isolasi tenant dan outlet dipaksa; role yang benar.
- Migration 0063–0067: aman untuk data lama. Tandai migration yang tidak bisa dibatalkan. Nomor yang bentrok dengan `ws/kds` dan `ws/pos-payment-fixes` dirapikan saat merge; itu bukan temuan.
- Test benar-benar membuktikan klaim, termasuk test race dengan dua transaksi DB. Boleh reproduksi dengan DB sementara (`~/.claude/scripts/colima-up`), bersihkan sesudahnya.

## Laporan
Temuan urut paling berat: file:baris, masalah, skenario gagal konkret, fix. Tandai untuk tiap dari lima temuan putaran 1: tertutup atau belum. "Tidak ada blocker" bila memang tidak ada.
