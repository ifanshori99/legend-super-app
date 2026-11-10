# Brief: second-opinion — tagih selisih charge order di kasir (legend-i83ls, legend-800h1)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/i83ls-fix`, cabang `ws/i83ls-fix`, SHA `3b3e2be3`.
Rentang diff: `git diff 5558eca2 3b3e2be3` (abaikan drizzle `meta/*.json` dan test).

## Berkas berisiko
- `apps/api/src/services/order-recovery-charge-pos.ts`
- `apps/api/src/services/order-recovery-charge.ts`
- `apps/api/src/services/order-recovery-charge-payment.ts`
- `apps/api/src/services/accounting-auto-journal-amounts.ts`
- `apps/api/src/services/pos-order-payment.ts`
- `apps/api/src/routes/order-recovery-charge.routes.ts`
- `apps/api/src/worker-main.ts`
- `apps/api/drizzle/0229_order_issue_refund_rejected.sql`

## Invariant (PRD)
- Uang tidak boleh terhitung dua kali: selisih swap ditagih sekali (tunai di kasir ATAU QR), pembayaran ganda di-refund otomatis.
- Setiap uang masuk tercatat di shift kasir dan dijurnal seimbang (kas, penjualan, service, PBJT).
- Total order beku setelah swap; selisih lewat charge terpisah.
- Idempotensi: kunci yang sama = hasil sama, tidak ada booking ganda.
- Tidak ada deadlock antara tender POS, webhook QR, dan tagih di kasir.
- Isolasi tenant dan outlet di setiap query; izin `pos.payment.accept` dicek untuk outlet charge.

## Effort
xhigh.

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
