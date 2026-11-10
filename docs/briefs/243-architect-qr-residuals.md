# Brief architect: review diff gabungan ws/refund-qr-residuals (read-only)

Worktree /Users/ifanshori99/Projects/legend super app/legend/.worktrees/refund-qr-residuals, `git diff ee7632cf..HEAD`. Jangan edit, jangan jalankan test, jangan pkill. Tingkat K (uang). Tiga kartu:
- legend-g510l: cabang voided/sesi-ditutup di handleQrOrderPaymentPaid (services/qr-order-consumers.ts) menerima intent paid dan partially_refunded.
- legend-p61pe: failRefund (services/payment-refund.service.ts) memanggil refileQrLatePaymentAfterFailure: bila refund yang gagal bukan refund late-payment dan ada key `qr-late-payment-refund:<intent>` serta order QR voided di link intent, ajukan refund late-payment baru (key `<key>:<failedRefundId>`, requestQrLatePaymentRefund keySuffix). Import dinamis karena siklus.
- legend-nslvm: qrSaleInUseOfIntent (services/payment-admin.service.ts) menghitung juga intent non-payer di link order (alokasi = evidence - unallocated, maks total-DP); consumer memeriksa semua intent kontributor di bawah kunci dan void bila refund committed.

Periksa dan laporkan hanya temuan nyata (file:baris, skenario):
1. Siklus kunci/deadlock: services/payment.service.ts sekitar baris 718, 1470, 1498 (settlement) dan openRefundChainSafely / lockRefundGraph di payment-refund.service.ts; urutan order -> link -> intent(s) ascending -> refund. Terutama kunci banyak intent kontributor di consumer (lockIntentsForFact) dan refile dari failRefund (kunci intent sudah dipegang).
2. refileQrLatePaymentAfterFailure: loop tak terbatas, double refund, refund gagal pada fund, jalur failRefund yang dipanggil tanpa kunci intent, key LIKE.
3. Split bill: false void pada pembayaran normal, jumlah `part`, intent dengan alokasi 0, hold ganda di refundableBalance (payer menahan total-DP penuh vs kontributor lain), konsistensi dengan guard payout (accounting-auto-journal-guards.ts qrSales yang hanya menghitung payer).
4. Regresi pada jalur refund late-payment, double_payment, POS.
Tulis laporan akhir ringkas; jika sudah membaca cukup, berhenti dan laporkan.
