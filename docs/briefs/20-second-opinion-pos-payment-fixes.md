# Brief: second-opinion — fix pembayaran POS (legend-b0au, legend-94qt, legend-0gy1)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` dan `~/.agents/team/TEAM.md`. Read-only: jangan ubah kode, jangan commit. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/pos-payment-fixes`, cabang `ws/pos-payment-fixes` (HEAD `165f36d`). Diff: `git diff main...ws/pos-payment-fixes`.

## Fokus (area uang)
- QRIS tender: expired/failed/void/complete/ganti metode; pembayaran terlambat tertangkap dan di-refund tepat sekali; tidak ada tagih dobel; race webhook vs void.
- Kunci DP per sesi meja: DP tidak bisa terpakai dua kali lewat QR checkout + POS bersamaan; deadlock; error DB tidak ditelan.
- `overrideId`: persetujuan supervisor sekali pakai, 15 menit, id dari server; tidak bisa dipakai lintas order/tenant/aksi.
- Migration `0063_known_gladiator`, `0064_smiling_gravity`: aman untuk data lama, CHECK tidak memblokir baris historis.
- Test benar-benar membuktikan klaim (bukan hanya hijau). Boleh reproduksi dengan DB sementara (`~/.claude/scripts/colima-up`), bersihkan sesudahnya.

## Laporan
Temuan urut paling berat: file:baris, masalah, skenario gagal konkret, fix. "Tidak ada blocker" bila memang tidak ada.
