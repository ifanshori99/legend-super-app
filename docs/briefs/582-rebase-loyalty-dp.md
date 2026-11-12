# Brief: engineer (Codex) — selaraskan ws/loyalty-dp-race dengan milestone/m1

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu", "Kerja berat" di `~/.agents/team/TEAM.md`. Konteks area: `docs/briefs/567-loyalty-money.md`, `573-loyalty-dp-refund.md`, `580-loyalty-dp-race-fix.md`.

## Masalah
Merge train batch52 berhenti: `claimSessionPoints` di m1 memakai callback idempotensi, sedangkan loyalty (ws/loyalty-dp-race 31643526) menambah transaksi pause entitas yang harus commit sebelum respons 409. Bukti konflik: `/tmp/batch52-loyalty-conflicts.txt` (bila ada), bead `legend-4q4b1`.

## Tujuan
1. Worktree basis `milestone/m1` terbaru. Cabang `ws/loyalty-dp-m1`. Gabungkan (merge, bukan rebase yang menulis ulang riwayat) `ws/loyalty-dp-race` dan selesaikan konflik dengan perilaku yang benar untuk keduanya: idempotensi m1 tetap (permintaan ulang dengan key sama = hasil sama, tanpa poin ganda), pause entitas tetap commit dan 409 tetap dikembalikan, pengaman edge Q58 (f1381404) tetap menolak klaim dari edge.
2. Migrasi: biarkan nomor 0403-0405 + 0411; merge train yang menomori ulang.
3. Test: semua test loyalty/refund/DP/accounting dari cabang + test idempotensi klaim m1 + test penolakan edge lulus. Tambah test untuk kombinasi: klaim diulang saat entitas di-pause.

## Uang (Jangan sampai rugi)
Tidak ada poin atau refund ganda di jalur mana pun. Ragu: pilih yang membatasi, lapor CTO.

## Bukti selesai
- Test terarah lulus, typecheck api/shared, ESLint + Prettier.
- Satu subagent architect effort xhigh (uang) mereview resolusi konflik saja.
- Push `ws/loyalty-dp-m1`. Jangan `pnpm check` penuh, jangan sentuh milestone/m1 atau main.
