# Brief: second-opinion — refund recovery + promo kegagalan final (pti5r)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree baca: `git worktree add --detach .worktrees/so-422 origin/ws/pti5r-promo-refund` (095b4099), hapus setelah selesai.
Rentang: `git log --oneline origin/milestone/m1..origin/ws/pti5r-promo-refund` (refund-recovery-fix 121b9e50/00caa599 dan pti5r f6f62af8..095b4099). Fokus `apps/api/src/services/order-recovery-refund*.ts`, `pos-refund*`, ledger promo, runbook + query cek data lama.

## Invariant
- Total refund per order tidak pernah melebihi yang dibayar; tidak ada refund dobel saat retry/paralel.
- Gagal final: ledger promo tidak disentuh, payout tetap tercatat untuk baris itu, item lain tidak menyerapnya.
- Lapor ulang setelah gagal final mengajukan ulang jumlah dan split yang sama, dibatasi sisa dana; `rejected` berakhir `nothing_left`.
- Open bill dan rantai lapor ulang A->B->C konsisten; isolasi tenant + RLS; audit lengkap.
- Query backfill/cek data lama aman di produksi (read-only atau idempoten).

## Effort
xhigh (uang).

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
