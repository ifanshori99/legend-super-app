# Brief: second-opinion — WS-08 bagian B (consent, pelanggan pesanan POS, profil member) + expiry FIFO w5by9

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree baca: `git worktree add --detach .worktrees/so-411 origin/milestone/m1` (46352cd5), hapus setelah selesai.
Rentang: bagian B `git diff c129293e^ 6fb77d06 -- <berkas>`; w5by9 `git show 8f0b4630 d735d8b7`. Baca versi terkini di m1. Bagian A sudah direview di brief 383.

## Berkas
`consent.service.ts`, `pos-order-customer.service.ts`, `crm-ledger.ts`, `loyalty-program.service.ts`, `point-ledger.service.ts` (bagian expiry), profil member routes/service.

## Invariant
- Consent: data pemasaran hanya dipakai bila consent aktif; pencabutan berlaku segera; riwayat consent append-only.
- Pelanggan di pesanan POS: kasir hanya menautkan member tenant sendiri; tidak membocorkan data member lain (telepon/email tersamar).
- Profil member: member hanya melihat/mengubah datanya sendiri; isolasi tenant + RLS.
- Expiry poin FIFO deterministik, tidak dobel kedaluwarsa, tidak membuat saldo minus, aman saat redeem paralel.

## Effort
xhigh (poin = nilai uang, data pribadi).

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
