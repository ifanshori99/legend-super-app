# Brief: second-opinion — refund followups 2 (ws/refund-followups-2)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/refund-followups-2`, cabang `ws/refund-followups-2`, di-rebase ke batch17 9fb949ca (berisi 181 dan refund-tier legend-2dnh/zi9o).
Rentang diff: `git diff 9fb949ca de319fef` (abaikan `docs/briefs/*` dan `docs/PROGRESS.md`). Konteks: `git diff 27ba1fb9 d2f8c072` (run 181b).

## Berkas berisiko
- `apps/api/src/services/accounting-auto-journal-void.ts` (void penjualan QRIS mengkredit balik `customer_deposit`)
- `apps/api/src/services/accounting-auto-journal-guards.ts` (`backingStatesOf`: reversal ACC-01, void terposting di `intentBackedAt`)
- `apps/api/src/services/qr-order-late-payment.ts` (jumlah refund late payment QR vs refund pending)
- `apps/api/src/services/pos-order-late-payment.ts` (jumlah refund late payment vs refund pending)
- `apps/api/src/services/payment-refund.service.ts` (`applyApproval`: approval refund late payment tidak menghitung refund lain yang masih `pending`; `isLatePaymentRefund` lewat `payment_admin_idempotency`)
- `docs/runbooks/auto-journal-sale-missing.md` (langkah rilis: re-queue void parkir lama dan payout-nya)

## Invariant (PRD)
- Uang intent tidak pernah keluar dua kali dan uang tamu tidak tertahan: refund late payment + refund lain tidak melebihi yang diterima; refund pending yang gagal tidak membuat sisa uang tamu hilang; urutan approval (late dulu atau pending lama dulu) tidak mengubah total yang diterima tamu.
- Jurnal: payout intent tidak mengeluarkan dari `customer_deposit` lebih dari yang dimasukkan penerimaan + kredit balik void/refund POS yang benar-benar terposting dan tidak di-reverse.
- Void penjualan QRIS membalik jurnal penjualan; bagian gateway kembali ke `customer_deposit`, metode yang belum didukung tetap parkir.
- Isolasi tenant di setiap query.

## Effort
xhigh.

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
