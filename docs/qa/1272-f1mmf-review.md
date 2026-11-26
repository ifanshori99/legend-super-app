# Review K f1mmf backend tukar menu (ws/1272-f1mmf)

Reviewer: architect (Opus, xhigh), 27 Nov. Baca kode saja. Hasil: **GAGAL**, 1 blocker, 2 sedang.

## Aman
QRIS, tunai, mulai EDC mengunci tagihan lalu advisory lock yang sama dengan agent EDC (agent cek ulang di bawah kunci, tanpa deadlock). Nominal dari `charge.amountIdr`; kunci idempotensi terikat terminal + reference + nominal. 404 untuk tenant/scope/outlet/izin lain.

## Temuan
1. **Blocker (bayar ganda)**: `order-recovery-charge-payment.ts` ~:351 `createIssueChargePayment` (jalur tamu QRIS/VA) tanpa `assertNoEdcSaleOutstanding`. Fix: panggil sesudah `lockSessionCharge`, sebelum `assertNoActiveQrisHold`; test gagal-dulu.
2. **Test kurang**: `edcSaleChargePayable` (`pos-order-support.ts`) via endpoint EDC umum dengan id tagihan sebagai reference: nominal salah, tagihan dibayar/tutup, order void, kode hidup; plus 404 EDC kasir tanpa izin.
3. **Tunai saat kode QRIS hidup** tetap diterima (pola lama 800h1).

## Keputusan CTO 27 Nov
- 1 dan 2: dibetulkan.
- 3: paling ketat. Tunai juga menolak selama `liveCodeWhere` (sama dengan EDC dan kunci layar).
- (d) dibangun sesuai desain architect: `resolvePosIssueChargeAttempt` (shared `pos/issue-charge.ts`), service `order-recovery-charge-pos-resolve.ts`, route `POST /order-issue-charges/:chargeId/attempts/resolve` (middleware sama `/edc`), penanda tutup di `pos_order_idempotency` (tanpa migrasi), EDC unknown lewat `resolveEdcReconciliation`. Penyetuju bukan pemanggil + PIN + alasan + audit.
- Menyatakan lunas lewat slip (EDC unknown) butuh `payment.reconcile` selain PIN supervisor. Dinyatakan gagal cukup PIN supervisor.
- Test wajib (d): penyetuju = pemanggil 403; PIN salah dihitung; outlet lain 404; permintaan telat dengan kunci tertutup ditolak tanpa tanya terminal; unknown tanpa slip / dalam jendela / terminal memproses = 409; slip nominal beda 409; slip valid dibayar sekali; dinyatakan gagal -> QRIS boleh, persetujuan telat sesudahnya ditandai dan semua jalur terkunci; total diterima tidak pernah > `amount_idr`.
- Sesudah backend lulus re-review: web (hapus CONTRACT_PENDING, tombol EDC, blocker a/b/c/e 25 Nov, screenshot 390/1280).
