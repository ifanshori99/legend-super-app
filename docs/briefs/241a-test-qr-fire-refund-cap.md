# Brief test-writer: fire QR vs refund committed (legend-9vzvs)

Worktree: /Users/ifanshori99/Projects/legend super app/legend/.worktrees/refund-qr-payfirst-guard. Jangan pindah, jangan commit, jangan edit src non-test.
Buat `apps/api/src/test/qr-order-fire-refund-cap.test.ts`. Pola seeding dan pemanggilan `handleQrOrderPaymentPaid`: `apps/api/src/test/qr-order-double-pay-payer.test.ts` (kode superseded dan payer), `qr-order-late-payment.test.ts` (refund late payment), `payment-refund-qr-sale-guard.test.ts` (insert refund mentah, approve, FakeRefundGateway).

Perilaku baru di `handleQrOrderPaymentPaid` (qr-order-consumers.ts, sebelum fireQrOrder): kunci intent payer, lalu bila (reserved - pending) + (total - DP order) > cap pada intent payer, order di-void (reason `refund_committed`) dan refund late-payment diajukan, order TIDAK fire. Refund `pending` tidak memblokir: order fire, approve-nya lalu gagal `cap_exceeded` (REFUND_INTENT_IN_QR_SALE di request).
Kasus:
- F1 (gagal-dulu, skenario utama) intent paid 100000, order QR awaiting_payment 100000; refund 100000 dibuat lalu di-approve (status approved, belum selesai: gateway belum dipanggil / fake tahan); consumer payment.paid dijalankan: order voided, TIDAK fired_at, refund late-payment untuk sisa (0 -> tidak ada baris baru), hasil outcome menyatakan void. Di basis order fire dan uang keluar: assertion order.status voided dan fired_at null harus gagal di basis.
- F2 refund 100000 masih `pending`: consumer fire order; approve refund lalu gagal cap_exceeded, gateway tidak dipanggil.
- F3 kode superseded: intent A (expired/superseded) membayar bill, order.payment_intent_id awalnya B; refund approved atas A; consumer event A: order voided (kunci dan cek memakai intent payer A), bukan fire.
- F4 tanpa refund: order tetap fire, fired_at terisi, payment_intent_id = payer (regresi).
- F5 refund approved sebagian (40000 dari 100000), order 100000 -> void + refund late-payment 60000 diajukan (sisa).
Jalankan HANYA: bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/qr-order-fire-refund-cap.test.ts" pnpm test'. Dilarang suite penuh, dilarang pkill atau menghentikan proses global. Lapor lulus/gagal per kasus dan asumsi. Test akan gagal sampai implementasi (oleh agent utama) selesai; kasus F2 dan F4 boleh lulus.
