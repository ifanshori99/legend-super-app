# Review uang C2a (cb067428a, 26 Nov): TIDAK LULUS, tanpa P0/P1

Path `apps/api/src/`. Wajib di cabang ini: 1, 2, 4, (c). Lalu re-review diff.

1. P2 `services/payment-gateway-select.ts:204`: kanal dicek pada probe Rp10.000; VA lama di-void lalu kode baru ditolak. Ambil kanal dari `methods(..., amountIdr)`; nominal juga di `services/qr-order-payment.ts:928`. Test.
2. P2 `qr-order-payment.ts:814,933`: berjalan sebelum QRIS pending yang sama dikembalikan; gagal baca metode jadi 400. Cek hanya di `voidOldCodesForChange` sesudah `scope` tidak null; gagal baca = 503.
3. (kartu, sebelum VA/e-wallet/kartu dibuka) `services/payment.service.ts:1006`: tautan DP lolos penjaga satu kode. DP: 409 selama kode non-QRIS hidup.
4. P3 `test/payment-1269-c2a-links-dp.test.ts:280`: tambah `closedIntentNeedsOpenBill`, uji jalur Duitku asli.

(a) Kartu sebelum rilis: `services/payment-routing.service.ts:99,138` tanpa aturan pakai `platformDefaultGateway()`; null = nonaktif; test legacy tetap `doit`. Runbook `gateway:set duitku --enabled --default`, `gateway:set doit --disabled`, periksa aturan tiap tenant.
(b) Kartu yang sama dengan 3: `payment.service.ts:1277` VA/bank_transfer maksimal `max(link.expiresAt, now+10 menit)`; e-wallet/kartu jangan dipendekkan; `payment-duitku.ts:486` ceil jadi floor.
(c) `config/env.ts:287` tolak query, hash, userinfo; production wajib path `/bayar/kembali`; samakan `deploy/single-vm/runtime.env.example:115` (berkas contoh, bukan rahasia).
