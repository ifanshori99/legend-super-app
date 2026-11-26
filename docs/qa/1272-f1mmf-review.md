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

## Review K (d) 27 Nov (6cabc2655..681ed30e0): LULUS dengan 1 P2
Aman: bayar ganda tertutup (penanda tutup di bawah kunci tagihan + advisory lock agent), referensi dibuat server, settle slip butuh `payment.reconcile` + PIN + jendela telat lewat + terminal diam + nominal sama, unknown tidak tertutup diam-diam, outlet lain 404 sebelum PIN.
Wajib sebelum web:
- P2 `order-recovery-charge-pos-resolve.ts:208` `record()`: sale approved tanpa tanda rekonsiliasi tidak cek nominal. Fix: `sale.mode !== "ecr" || sale.method !== "card" || sale.amountIdr !== charge.amountIdr` -> 409. Test gagal-dulu: nominal lain 409, tagihan tetap open.
- P3 `:250`: nominal slip beda -> panggil `alertEdcReconciliationMismatch` sebelum 409.
- P3 `pos-order-support.ts:537`: hapus `if (!charge) return false;` ganda.
- P3 test: approved tanpa tanda (jawaban tidak sampai kasir) = `recorded` sekali, ulang tetap sekali; 404 outlet lain untuk `method: "edc"`.
Cek fix: satu reviewer sonnet atas diff fix.
