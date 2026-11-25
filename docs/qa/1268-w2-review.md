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
