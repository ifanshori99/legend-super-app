# Brief: second-opinion — Wi-Fi edge (kuota dan voucher)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree baca: `git worktree add --detach .worktrees/so-415 origin/milestone/m1`, hapus setelah selesai.
Rentang: `git diff e79e86a0^1 e79e86a0^2` dan `git diff 8b57852f 52c7c7ef`. Baca versi terkini di m1.

## Berkas
`wifi-*.ts`, `edge/wifi-quota-applier.ts`

## Invariant
- Kuota/voucher Wi-Fi tidak bisa dipakai lintas tenant/outlet; tidak bisa dipakai dobel.
- Edge offline lalu sinkron: tidak menggandakan atau menghapus kuota; konflik deterministik.
- Kredensial perangkat edge tidak bocor; endpoint edge terautentikasi.

## Effort
high.

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
