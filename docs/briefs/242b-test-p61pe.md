# Brief test-writer: legend-p61pe (refund failed sesudah order QR di-void tidak di-refund otomatis)

Worktree: /Users/ifanshori99/Projects/legend super app/legend/.worktrees/refund-qr-residuals. Jangan pindah, jangan commit, jangan edit src non-test. Dilarang suite penuh dan pkill.
Buat `apps/api/src/test/qr-order-late-refund-after-failed.test.ts`. Pola: `qr-order-fire-refund-cap.test.ts` (order QR awaiting_payment + intent paid + refund approved mentah + panggil handleQrOrderPaymentPaid), `payment-refund-approval.test.ts` / `payment-refund-codex-fix.test.ts` (approve lewat HTTP, FakeRefundGateway yang menolak payout -> refund `failed` provider_declined).

Bug: order QR di-void karena `refund_committed` (refund R approved 100% sudah mengambil uang): requestQrLatePaymentRefund memakai key sekali pakai `qr-late-payment-refund:<intentId>` yang menyimpan refundId null (sisa 0). Bila R kemudian `failed` (payout ditolak provider, atau cap_exceeded), uang tamu tidak kembali dan tidak ada refund otomatis.
Perilaku baru (di failRefund, services/payment-refund.service.ts): bila refund yang gagal BUKAN refund late-payment, intent-nya punya baris key `qr-late-payment-refund:<intent>` di payment_admin_idempotency, dan order QR di link intent itu berstatus voided, maka diajukan refund late-payment baru (requester system:qr) sebesar cap - (reserved - pending), key `qr-late-payment-refund:<intent>:<failedRefundId>`. Sisa <= 0: tidak ada refund.
Kasus (P1 gagal-dulu):
- P1 order voided `refund_committed` lewat consumer dengan R approved 100000; R lalu gagal (decline provider via flow nyata, atau panggil jalur yang membuat failed); ada refund baru 100000 requested_by system:qr berstatus pending untuk intent yang sama.
- P2 refund gagal pada intent biasa (tanpa order QR voided / tanpa key): tidak ada refund baru.
- P3 refund late-payment itu sendiri gagal: TIDAK diajukan ulang (cegah loop).
- P4 replay/pengulangan gagal kedua (refund baru P1 juga gagal) -> tidak ada refund ketiga.
Jalankan HANYA: bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/qr-order-late-refund-after-failed.test.ts" pnpm test'. Lapor lulus/gagal per kasus dan asumsi (terutama cara membuat refund failed).
