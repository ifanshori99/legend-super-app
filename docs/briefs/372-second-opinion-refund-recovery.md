# Brief: second-opinion — refund recovery pesanan (ws/94q2l-impl)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Buat worktree baca: `git worktree add .worktrees/so-372 b78f169c` (detached), hapus setelah selesai (`git worktree remove .worktrees/so-372`).
Rentang diff: `git diff b6a38096 b78f169c` (abaikan drizzle `meta/*.json` dan test).

## Berkas berisiko
- `apps/api/src/services/order-recovery-refund.ts`
- `apps/api/src/services/order-recovery-refund-amount.ts`
- `apps/api/src/services/accounting-auto-journal-recovery-refund.ts`
- `apps/api/src/services/accounting-auto-journal-guards.ts`
- `apps/api/src/services/payment-refund.service.ts`

## Invariant (PRD)
- Refund tidak pernah melebihi yang dibayar; refund parsial berulang tidak dobel.
- Setiap refund dijurnal seimbang (pembalik penjualan, service, PBJT, kas/gateway) dan tidak dijurnal dua kali.
- Refund wajib approval sesuai matriks; penyetuju beda dari pemohon.
- Poin loyalty dan klaim dibatalkan sebanding saat refund.
- Idempotensi webhook/refund gateway; tidak ada balapan antara refund dan pembayaran masuk.
- Isolasi tenant dan outlet di setiap query.

## Effort
xhigh.

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
