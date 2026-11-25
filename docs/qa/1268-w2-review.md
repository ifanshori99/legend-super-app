# 1268 W2 review uang (2e377153d): TIDAK LULUS, 2 P1 3 P2

Path web: `apps/web/src/features/ws04-pos-kasir/`. Tidak ada bayar ganda di server; masalahnya kasir buntu dan celah kunci.

1. **P1** `payment-intent-store.ts:193`: EDC terkunci permanen. Permintaan hilang, PIN lewat 15 menit (`pos-order-support.ts:1006`), kirim ulang selalu 403 `EDC_STANDALONE_APPROVAL_REQUIRED`. Kode itu definitif saat replay (dilempar sesudah cek idempotensi dan kunci order; tulis komentar dan test server yang membuktikan urutannya).
2. **P1** `payment-intent-store.ts:194-199`: gateway 503 (`payment-gateway.ts:196`) mengunci tunai. 503 tetap tidak definitif; jalan keluarnya endpoint resolve.
3. **P2** `hooks.ts:276`, `payment-screen.tsx:301`, `gateway-parts.tsx` StartPanel: kunci hilang selama `sending`. Status `sending` mengunci semua panel selain pengirim, tombol mati, juga sesudah Kembali lalu masuk lagi.
4. **P2** `api.ts:771,883,914`: simpan dan kirim `expectedVersion` (`endpoints.ts:133`) di SEMUA body bayar; poin: tambah di kontrak server (sekarang null).
5. **P2** `payment-screen.tsx:367`: QRIS tercatat tetapi jawaban hilang; panel kunci menutupi status/batal. Keluar lewat resolve.
6. **P3 betulkan** `payment-screen.tsx:301` (hapus catatan saat lunas terbukti dari server); `edc-standalone.tsx:936` (kunci PIN memuat `bankRef`).
7. P3 kartu terpisah: RRN tidak unik, satu slip untuk dua tagihan.

Batal QR kunci baru tiap tap: aman. Tunai, QRIS kedaluwarsa, struk: baik. Gabung W1 bersih (typecheck gabungan belum).

## Keputusan CTO (a dan b, sesuai usul architect)

- Kasir lain tidak boleh mengirim ulang. Kasir awal bisa masuk PIN; bila pulang: endpoint `payment-intents/resolve` (izin supervisor/manager yang sudah ada untuk persetujuan POS, PIN, alasan wajib, audit, outlet dari sesi).
- Di bawah advisory lock kunci: sudah tercatat -> muat hasil; belum -> tombstone kunci dengan fingerprint lain sehingga kiriman terlambat ditolak.
- Catatan rusak (kunci tak terbaca): di bawah lock order, tolak bila ada tender authorized, hold aktif, EDC terbuka, atau dana terparkir; lunas -> muat; bersih -> naikkan `version` sebagai pagar (butuh no. 4 di semua body).
- Server tidak terbaca: tetap terkunci. EDC standalone "belum tercatat": sebelum dibuka, supervisor wajib menyatakan kartu tidak terdebit atau mencatat pembayarannya; jangan pernah otomatis dianggap gagal.
- UI memakai pola dialog PIN/persetujuan yang sudah ada, tanpa layar baru.

Urutan: 1, 3, 4, 6; lalu endpoint dan UI resolve + test konkurensi (kiriman terlambat vs resolve dua arah); lalu test tambahan: 403 EDC replay, 503 QRIS berulang, pindah metode saat sending, dua konteks (dua konteks JS terpisah), versi berubah. Migrasi: hindari; bila tak terhindar pakai 0531 dan lapor.

## Keputusan CTO 26 Nov atas aeb824701

1. 403 `EDC_STANDALONE_APPROVAL_REQUIRED` saat kirim ulang = server belum mencatat, BUKAN berarti kartu tidak terdebit. Metode lain tetap terkunci. Dua jalan keluar saja: (a) minta PIN persetujuan baru lalu catat ulang EDC yang sama (nominal, terminal, `bankRef` dari catatan, tidak bisa diubah); (b) resolve supervisor dengan pernyataan "kartu tidak terdebit" + alasan.
2. Catatan rusak dan kartu ternyata terdebit: tetap terkunci untuk metode lain, tetapi supervisor harus bisa mencatat pembayaran EDC dari slip (RRN, approval, nominal = sisa tagihan) lewat alur EDC persetujuan yang sudah ada; sesudah lunas kunci lepas. Tanpa jalan itu kasir buntu.
3. Cek izin resolve: `pos.edc_standalone.approve` / `pos.void.approve`, penyetuju orang lain. Diterima.

## Re-review 26 Nov (aeb824701): server LULUS, web EDC TIDAK. Sesuai architect, diterima CTO.

1. **P1** `payment-intent-store.ts:221-240`: aturan per jenis. Semua penolakan `edc_standalone` (403/404/409/412/423; kirim pertama, replay, "recording" `replay:false` di `api.ts resolvePayment`) tetap mengunci metode lain.
2. **P2** `api.ts:837`: simpan `amountIdr` slip di catatan; beda dari sisa tagihan = tolak, tetap terkunci.
3. **P2** `api.ts:476`, `payment-intent-store.ts:200`: hapus catatan EDC hanya bila tender captured cocok `bankRef`; selain itu peringatan "kartu mungkin terdebit, void di mesin" sampai ditutup supervisor.
4. Jalan keluar (c): "kartu terdebit, sudah di-void/refund di mesin" + nomor void + PIN + alasan + audit. Jadi keluar EDC: (a) catat ulang sama, (b) tidak terdebit, (c) sudah di-void.
5. Catatan rusak: diganti catatan EDC baru dalam satu tulisan (pola `settleStored`); ditolak = tetap terkunci; nominal slip diketik = sisa, selain itu (c). Izin `pos.edc_standalone.approve`, bukan `void`.
6. P3 kartu: pagar versi dengan tender menunggu lock (test); catatan rusak + QR hidup + provider diam perlu jalan ke release manajer.
7. Tes wajib: 412/409/423 di tiga jalur tetap terkunci; nominal berubah; lunas cara lain dengan catatan EDC; keluar (c). Lalu review delta.
