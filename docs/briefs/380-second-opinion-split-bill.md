# Brief: second-opinion — WS-03 split bill dan claim token

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree baca: `git worktree add --detach .worktrees/so-380 milestone/m1`, hapus setelah selesai.
Rentang awal: `git show c6916247` dan `git show e4efc823`. Baca versi terkini berkas di milestone/m1 (sudah ada fix sesudahnya). Pindah/gabung meja (dcd99cbc, 1ead4c4d) diperiksa terpisah. Fix yang sedang dikerjakan di cabang lain: klaim tersembunyi (udu47) dan balapan klaim (ec6fa); temuan di area itu tetap dilaporkan, beri tanda "mungkin tertutup udu47/ec6fa".

## Berkas
- `apps/api/src/services/bill-split.service.ts`
- `apps/api/src/services/qr-order-payment.ts`
- `apps/api/src/db/schema/bill-splits.ts`
- `apps/api/src/services/qr-order-consumers.ts`
- `apps/api/src/services/payment.service.ts` (bagian split)

## Invariant
- Jumlah semua bagian split = total tagihan persis (subtotal setelah diskon, service, PBJT; sisa pembulatan deterministik); tidak ada item dibayar dua kali atau terlewat.
- Satu bagian hanya bisa diklaim dan dibayar sekali; dua tamu tidak bisa membayar bagian yang sama (kunci + idempotensi).
- Token klaim tidak bisa ditebak, berlaku 24 jam setelah meja tutup, hanya membuka bagian meja itu; tidak bocor data tamu lain.
- Perubahan pesanan setelah split (tambah/batal item, swap) membuat split dihitung ulang atau ditolak, bukan tagihan lama tetap jalan.
- Poin loyalty per tamu sesuai bagiannya (setelah diskon, sebelum pajak dan service).
- Isolasi tenant dan outlet.

## Effort
xhigh.

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
