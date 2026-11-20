# Second opinion lanjutan 1216 (20 Nov), kode int/batch101

## F Akuntansi — TIDAK
- P1 Distribusi approved tetap dibayar dengan angka lama sesudah periode dibuka ulang. `profit-share-distribution.service.ts:1889-1937` (recordDistributionPaymentService) dan pemicu `0218_profit_share_unabsorbed.sql:~172` tidak cek status/versi periode; `reopen_fiscal_period` (`0273:159-178`) tidak melihat distribusi. Skenario: Maret tutup v1, distribusi laba 60 jt approved, buka ulang, gaji 30 jt diposting, tutup v3, pembayaran tetap 60 jt.
- P1 Pembalikan manual jurnal otomatis tanpa approval. `routes/accounting.routes.ts:193-210` -> `accounting-journal.service.ts:1037-1060`; hanya kas kecil yang dijaga (`:1121`). Membalik akrual payroll/HPP menghapus beban, laba naik, bagi hasil lebih.
- P2 stok negatif lalu restock: ditangani 1214 (receipt) + bead legend-slssv (jalur lain).
- Belum diperiksa: receipt biaya 0 saat saldo <= 0, tanggal jurnal penyelesaian distribusi di periode tutup, adjustment negatif vs pajak dipotong, pembalikan jurnal distribusi.

## G Payroll pajak dan akses — TIDAK
- P2 Karyawan keluar sesudah cutoff memacetkan payroll badan hukum (422 PAYROLL_PPH21_MONTH_PRIOR_INVALID). `payroll-run-simulate.service.ts:756-758` (masa terakhir dari bulan payDate), `:583`, `payroll-run-pph21.service.ts:437`. Cutoff 25, keluar 30 Nov: run Nov dihitung tahunan, run Des memuat lagi -> 422 untuk semua.
- P3 Keluar Desember, sisa gaji dibayar Januari: tahunan PTKP penuh, PPh21 ~0 (kurang potong, sanksi ke perusahaan).
- Lolos: mesin PPh21, rapel, matriks PII gaji, slip sendiri.
- Belum diperiksa: coretax A1, rapel finalize, penagihan piutang PPh21, pajak service charge, seed TER, payslip-pin, export; `payroll.view` scope outlet membuka gaji outlet (tampak disengaja).

## H CRM promo + refund — TIDAK
- P2 Refund parsial yang mencabut promo mengembalikan voucher dan kuota padahal tamu tetap menikmati sebagian diskon (`crm-promo-refund.ts:560-627`, `:717-721`; `uncoveredIdr` tidak dipakai). Voucher sekali pakai bisa dipakai berulang, outlet rugi.
- P3 Aplikasi lama `paid_idr` NULL: paid dihitung ulang dari diskon yang sudah turun (`:713-716`, `:871-873`); saat ini tertahan cap POS.
- Belum diperiksa: cap voucher permintaan maaf, refund points tender lama tanpa ledger, reprice refundSplit, consumer `promo_application.adjusted`.
