# Brief test-writer: legend-nslvm (split bill QR: refund di intent kedua tidak dicek cap)

Worktree: /Users/ifanshori99/Projects/legend super app/legend/.worktrees/refund-qr-residuals. Jangan pindah, jangan commit, jangan edit src non-test. Dilarang suite penuh dan pkill.
Buat `apps/api/src/test/payment-refund-qr-split-guard.test.ts`. Pola: `payment-refund-qr-sale-guard.test.ts` (seed intent paid + order QR mentah + requestRefund) dan `qr-order-fire-refund-cap.test.ts` (consumer fire).

Konteks: split bill = satu payment link, dua intent P1 (60000) dan P2 (40000) masing-masing dibayar sebagian (payment_evidence masing-masing); order QR pay_first total 100000 fired, `payment_intent_id` = P1 (payer = intent event pertama). Sebelumnya hanya P1 dianggap menahan seluruh total - DP; P2 tampak 100% refundable (bug).
Perilaku baru: refundableBalance (services/payment-admin.service.ts, qrSaleInUseOfIntent) menghitung untuk intent non-payer di link yang sama = min(total-DP, alokasi intent itu = evidence - unallocated funds); intent payer tetap total - DP. handleQrOrderPaymentPaid memeriksa SEMUA intent kontributor (alokasi > 0) di bawah kunci: bila refund committed (approved/completed, bukan pending) pada intent kontributor mana pun membuat committed + alokasi > cap, order di-void dan refund late-payment diajukan per intent kontributor.
Kasus:
- N1 (gagal-dulu) split 60000/40000, order fired pinned P1: refund 40000 pada P2 ditolak 409 REFUND_INTENT_IN_QR_SALE, tanpa baris refund; refundable listing P2 = 0. Refund P1 juga ditolak.
- N2 pinned P1 60000 dibayar, P2 40000 dibayar tetapi dicatat sebagai `double_payment` (payment_unallocated_funds amount 40000, bill sudah tertutup P1 100000 sendiri): P2 tetap refundable lewat jalur biasa/fund (tidak ditahan; alokasi 0).
- N3 (gagal-dulu) consumer: dua share dibayar, refund 40000 approved pada P2 sebelum event P1 diproses: order voided (bukan fired), refund late-payment diajukan untuk sisa P1 (60000 - refund committed P1 = 60000) dan P2 sisa 0.
- N4 regresi split tanpa refund: order fire, fired_at terisi, P2 refund ditolak (N1).
Jalankan HANYA: bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/payment-refund-qr-split-guard.test.ts" pnpm test'. Lapor lulus/gagal per kasus dan asumsi (terutama cara menyusun link dengan dua intent bagian-bayar).
