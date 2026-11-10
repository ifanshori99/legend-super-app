# Brief: second-opinion — refund setelah perbaikan 423 (pti5r b36d5d3c)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree baca: `git worktree add --detach .worktrees/so-427 origin/ws/pti5r-promo-refund` (b36d5d3c), hapus setelah selesai.
Rentang: `git log --oneline 095b4099..b36d5d3c` (perbaikan temuan Codex 422, brief `docs/briefs/423-refund-codex422-fixes.md`). Konteks review sebelumnya: `docs/briefs/422-second-opinion-refund-recovery.md`.

## Fokus
1. Apakah 3 P1 + 2 P2 dari review 422 benar tertutup (bandingkan dengan brief 423).
2. Perbaikan swap item 3 baris di b36d5d3c: belum dicek ulang architect. Periksa khusus.
3. Kasus terbuka (sudah diketahui, jangan dilaporkan ulang sebagai temuan baru, cukup konfirmasi cakupannya): order dengan promo, item ditukar ke menu lebih murah setelah refund gagal final, refund berikutnya masih membayar harga item lama padahal tamu sudah dapat voucher selisih.

## Invariant
- Total refund per order tidak pernah melebihi yang dibayar; tidak ada refund dobel saat retry/paralel.
- Gagal final: ledger promo tidak disentuh, payout tetap tercatat untuk baris itu, item lain tidak menyerapnya.
- Swap item tidak membuka jalan refund atau voucher dobel.
- Isolasi tenant + RLS; audit lengkap.

## Effort
xhigh (uang).

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
