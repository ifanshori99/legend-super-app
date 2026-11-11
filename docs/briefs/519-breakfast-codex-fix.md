# 519 Fix temuan Codex 518 sarapan (uang, tingkat K)

Worktree: .worktrees/breakfast-pay (ws/breakfast-pay). API: apps/api. Prinsip: tamu tidak boleh dirugikan (uang tertahan), outlet tidak boleh membayar lebih (cap tetap: total refund <= bayar).

## Butir 1: late refund gagal cap_exceeded saat refund admin pending
- apps/api/src/services/facility-breakfast-money.ts ~148-200: requestBreakfastRefund, key `facility-breakfast-refund:${kind}:${intent.id}` (kind cancel|late). Late: free = cap - (reserved - pending).
- apps/api/src/services/payment-refund.service.ts ~535: LATE_PAYMENT_REFUND_KEY_PREFIXES hanya pos-/qr-. isLatePaymentRefund membandingkan key = prefix+intentId. Akibatnya cek cap saat approve (fits = reserved - otherPending <= cap) tidak menghitung pending admin lain -> cap_exceeded.
- Fix: tambah prefix `facility-breakfast-refund:late:`. Uji approval sebenarnya: bayar 100.000, refund admin pending 10.000, refund late facility 100.000 -> approve late sukses; lalu admin 10.000 tidak boleh lolos (total <= bayar).

## Butir 2: pembatalan saat refund admin pending, refund itu ditolak/kedaluwarsa
- facility-breakfast-money.ts ~294-309: cancel memanggil requestBreakfastRefund(kind cancel); bila refund admin pending menahan saldo, free=0 -> refundId null, amount 0, tapi order tetap cancelled dan refundedIdr dibukukan. Tidak ada yang mengajukan ulang bila refund admin itu gagal.
- payment-refund.service.ts failRefund (~585-649) memanggil refileQrLatePaymentAfterFailure (key `qr-late-payment-refund:<intent>:<failedRefundId>`) dan refile recovery. Tidak ada untuk sarapan.
- Fix: setelah refund gagal (rejected/expired/failed) pada intent sarapan yang order-nya sudah cancelled, ajukan ulang SISA kewajiban (paid - refund completed/pending lain) dengan key turunan `facility-breakfast-refund:<kind>:<intentId>:<failedRefundId>`, intent lock dan cap sama. Tidak loop: refund sarapan sendiri yang gagal tidak diajukan ulang otomatis. Test: total refund (completed+pending) tidak pernah > bayar.

## Butir 3: payment.funds_unallocated milik sarapan
- facility-breakfast-consumers.ts: tidak ada handler funds_unallocated. Dispatch di services/order-payment-consumers.ts:131-144 (channel facility hanya payment.paid, else handleBreakfastPaymentClosed). Payload (accounting-auto-journal-amounts.ts:297): {unallocatedFundId, intentId, receivedIdr, receivedAt}; tidak ada paymentLinkId -> cari paymentIntents.paymentLinkId by intentId lalu orderIdOfLink (lihat handleBreakfastPaymentClosed ~420).
- Contoh refund per fund: requestQrDoublePaymentRefund di services/qr-order-late-payment.ts:206 (lock fund FOR UPDATE, skip bila ada paymentRefunds.unallocatedFundId live, insert refund penuh fund.amountIdr + audit). Hard-coded reason double_payment; sarapan perlu reason lain (uang telat setelah batal / intent closed).
- Fix: handler baru -> tepat satu refund penuh idempoten per fund. Test alur: batal -> Duitku BILL_CLOSED/uang telat -> funds_unallocated -> tepat satu refund; replay event tidak menambah.

## Test
- apps/api/src/test/facility-breakfast-*.test.ts, fixture facility-breakfast-helpers.ts (helper refund pending ada di :97). Contoh: facility-breakfast-refund-cap.test.ts (BRK-PAY-05/06), qr-order-late-refund-after-failed.test.ts, qr-order-double-pay-payer.test.ts.
- Jalankan terarah: `cd <worktree> && LEGEND_TEST_FILES="src/test/x.test.ts" heavy pnpm test`. HANYA satu proses test jalan sekaligus: subagent penulis test JANGAN menjalankan vitest; tulis saja, engineer yang menjalankan.
- ID ULID bila API meminta ULID; path test `src/test/...` relatif apps/api.

## Status (engineer)
- Butir 1 sudah diedit engineer (prefix di payment-refund.service.ts). Jangan ubah lagi bagian LATE_PAYMENT_REFUND_KEY_PREFIXES.
- Fail-first terbukti (log scratchpad/failfirst.log): test merah karena sebab benar (refund tidak diajukan ulang, 0 refund fund, 409 cap).
- Butir 2 (implementer A): failRefund hook di payment-refund.service.ts (region failRefund/refileQrLatePaymentAfterFailure) + fungsi refile baru di facility-breakfast-money.ts. Jangan sentuh facility-breakfast-consumers.ts / order-payment-consumers.ts.
- Butir 3 (implementer B): handler funds_unallocated di facility-breakfast-consumers.ts + dispatch order-payment-consumers.ts (+ helper refund-per-fund bila perlu, file baru atau di qr-order-late-payment.ts hanya bila generalisasi aman). Jangan sentuh payment-refund.service.ts / facility-breakfast-money.ts.
- JANGAN jalankan vitest/tsc. Engineer menjalankan. Jangan buat migrasi (butuh skema baru: berhenti dan lapor).
- Aturan uang: tamu tidak rugi, outlet tidak bayar lebih; ragu = batasi pembayaran, lapor.

## Putaran 2: temuan architect (xhigh) atas delta
Test hijau sampai sini. Key refile saat ini `facility-breakfast-refile:<intent>:<failedRefundId>` (99 char, batas idempotencyKeySchema 100).
- Temuan 1 (sedang-tinggi): apps/api/src/services/payment-admin-idempotency.ts:18-25 punya daftar prefix key milik sistem (dicadangkan). Prefix refile tidak ada di daftar -> staf bisa memakai key `facility-breakfast-refile:<intent>:<R.id>` untuk tulisan admin, lalu saat R gagal refile melempar IDEMPOTENCY_KEY_REUSED di dalam failRefund, transaksi batal, R tidak pernah bisa gagal, uang tamu tertahan. Fix: cadangkan prefix refile baru (cek bagaimana facility-breakfast-refund: dicadangkan; test seperti BRK-PAY-08). Docstring facility-breakfast-money.ts ~270 masih menyebut key lama: perbarui.
- Temuan 2 (sedang): refile hanya untuk order cancelled dengan paidIntentId. Jalur LATE (facility-breakfast-consumers.ts ~208, ~335, ~354): late refund = cap - refund yang sudah approved. Skenario: bayar 100.000, refund admin R 10.000 approved, order batal -> late refund 90.000, lalu payout R gagal (failRefund) -> tidak ada yang mengajukan ulang, tamu rugi 10.000. QR menangani lewat refileQrLatePaymentAfterFailure. Fix: bila intent punya key `facility-breakfast-refund:late:<intent>` yang refundId-nya BUKAN refund yang gagal, ajukan ulang kind late (maxIdr null, rumus late) dengan key turunan.
- Rencana key (semua <= 100 char, dicadangkan, ikut LATE_PAYMENT_REFUND_KEY_PREFIXES bila late): `fb-refile:cancel:<intent>:<failedId>` (90) dan `fb-refile:late:<intent>:<failedId>` (88). Ganti key `facility-breakfast-refile:` yang sekarang. Prefix `fb-refile:late:` harus ada di LATE_PAYMENT_REFUND_KEY_PREFIXES (payment-refund.service.ts ~535; isLatePaymentRefund cocok `prefix+intent` atau `prefix+intent:%`).
- Pembagian: implementer = kode produksi (facility-breakfast-money.ts, payment-admin-idempotency.ts, payment-refund.service.ts). test-writer = tests/ baru `apps/api/src/test/facility-breakfast-refile-hardening.test.ts` (key milik sistem dicadangkan -> staf tidak bisa memblokir refile; late: refund admin approved + payout gagal -> sisa diajukan ulang tepat sekali, total <= bayar). Test lama facility-breakfast-refund-refile.test.ts tidak diubah kecuali key lama dirujuk eksplisit.
- Jangan jalankan vitest/tsc.

## Putaran 3: hasil run facility-breakfast-refile-hardening.test.ts (sendirian)
Lulus: BRK-REFILE-07 (3), BRK-REFILE-09 kontrol pertama. Gagal 3:
- A (BUG UANG, produksi): refile jalur LATE memakai rumus late `cap - (reserved - pending)`, jadi refile mengajukan refund PENUH (86.625) ketika refund late L (76.625) masih pending -> dua refund pending 163.250 > bayar 86.625. Approval kedua memang gagal cap_exceeded (aturan QR), tetapi bila L (76.625) disetujui duluan, refile gagal dan tamu kurang 10.000 selamanya (tidak ada loop). Fix: SEMUA refile (cancel dan late) memakai rumus `cap - reserved` (kurangi pending): hanya sisa nyata (10.000), jumlah live tidak pernah > bayar, tanpa stacking. Key tetap `fb-refile:late:`/`fb-refile:cancel:`. Test no-loop dan after_fired/after_cancel sudah menegaskan total live <= bayar.
- B (test): BRK-REFILE-08 approvedAdminRefund (hardening.test.ts:286) menerima 409 "Refund could not be approved." saat approve refund admin 10.000 (raw pending). Diagnosa sebab (approver/role/policy/level/cap? bandingkan helper di facility-breakfast-late-refund-approve.test.ts yang sukses approve) dan betulkan TEST. Bila sebabnya perilaku produksi, lapor tanpa mengubah produksi.
