# Brief: second-opinion — WS-08 bagian A: ledger poin loyalty

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree baca: `git worktree add --detach .worktrees/so-383 milestone/m1`, hapus setelah selesai.
Rentang awal: `git diff b428e1bc^ e15950fe -- <berkas>`; baca versi terkini di milestone/m1. Bagian B (consent, pelanggan di pesanan POS, profil member) diperiksa terpisah.

## Berkas
- `apps/api/src/services/loyalty-earn-consumer.ts`
- `apps/api/src/services/point-ledger.service.ts`
- `apps/api/src/services/loyalty-program.service.ts`
- `apps/api/src/db/schema/crm-ledger.ts`
- `apps/api/drizzle/0203_member_loyalty_ledger.sql`

## Invariant (PRD D18 dan loyalty)
- Poin dihitung dari subtotal setelah diskon, sebelum pajak dan service; dari snapshot pesanan, bukan harga terkini.
- Event earn berulang/balapan tidak menambah poin dobel (idempotensi + kunci); refund/void membalik poin sebanding, tidak minus melebihi yang diperoleh.
- Saldo = jumlah ledger; ledger append-only, koreksi lewat entri pembalik.
- Redeem tidak melebihi saldo, termasuk dua redeem paralel; kedaluwarsa poin FIFO dan deterministik.
- Member hanya mendapat poin dari tenant/program yang dia ikuti; isolasi tenant dan RLS.
- Perubahan aturan program tidak mengubah poin yang sudah tercatat.

## Effort
xhigh (poin = nilai uang).

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
