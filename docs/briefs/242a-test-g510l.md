# Brief test-writer: legend-g510l (consumer QR: cabang voided / sesi ditutup melihat intent partially_refunded)

Worktree: /Users/ifanshori99/Projects/legend super app/legend/.worktrees/refund-qr-residuals. Jangan pindah, jangan commit, jangan edit src non-test. Dilarang suite penuh dan pkill.
Buat `apps/api/src/test/qr-order-late-partial-refund.test.ts`. Pola seeding: `apps/api/src/test/qr-order-fire-refund-cap.test.ts` (refund completed mentah, intent partially_refunded/refunded) dan `qr-order-late-payment.test.ts` (order voided + payment.paid terlambat), `ws03-guest-va.test.ts` (sesi ditutup, outcome late_payment_on_closed_session).

Bug: di handleQrOrderPaymentPaid (services/qr-order-consumers.ts) cabang `order.status === "voided"` dan cabang sesi ditutup (orderSessionActive false) hanya meneruskan bila intent berstatus `paid`. Intent `partially_refunded` (refund parsial completed sebelum event diproses) dikembalikan `unchanged` / `not_settled`, jadi sisa uang tidak di-refund.
Kasus (semua gagal-dulu kecuali kontrol):
- G1 order voided, intent paid 100000 lalu refund 30000 completed (intent partially_refunded), payment.paid diproses: refund late-payment 70000 diajukan (outcome late_payment_on_voided_order).
- G2 sama tetapi sesi meja ditutup dan order awaiting_payment: order di-void (payment_unpaid_session_closed) dan refund 70000 diajukan (outcome late_payment_on_closed_session).
- G3 kontrol: intent `refunded` penuh: tidak ada refund baru, tidak error (G3 boleh lulus di basis).
- G4 replay event G1: tetap satu refund late-payment.
Jalankan HANYA: bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/qr-order-late-partial-refund.test.ts" pnpm test'. Lapor lulus/gagal per kasus dan asumsi.
