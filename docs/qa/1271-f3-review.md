# Review K F3 jendela failover (ws/1271-f3 25084a5a0)

Reviewer: architect (Opus), 27 Nov. Baca kode saja. Hasil: **GAGAL ringan**, 0 P1, 2 P2. Re-review cukup diff perbaikan.

## Aman
- Gerbang default tolak; hanya rute inti `requireCorePosWriteOnCloud`, baris harus milik window aktif. QR tamu, table session, delivery, poin, recovery tetap gerbang lama.
- Race: tulis order/shift/struk mengunci window `FOR SHARE` (`pos-order.service.ts:336`); cancel/return `FOR UPDATE` lalu cek sisa kerja. Syarat F2 (a)(b) terpenuhi.
- `pos.failover.manage` dicek di rute dan di transaksi; window outlet lain 404.
- C1 sekali per window+perangkat, append-only. Kas tidak dobel.

## P2
1. `services/pos-edge-outlet.ts:172`: kill switch `EDGE_FAILOVER_ENABLED` mati saat window aktif dengan shift/order terbuka mengunci outlet (tutup shift, hitung laci, void ditolak; return `edge-failover.service.ts:707` dan cancel `:570` menolak karena kerja terbuka). Komentar `config/env.ts:294` salah. Perbaikan: flag mati = hanya penyelesaian baris window yang ada (count, close, force-close, void, batal QRIS/VA); tolak semua pembuatan baru. Test: flag mati + satu shift terbuka -> tutup shift, return berhasil.
2. `services/pos-order-corrections.ts:222`, `services/pos-payment-intent-resolve.ts:279`: tidak mengunci window di transaksi; refund bisa tercatat sesudah event penutup. Perbaikan: sesudah `lockPosOrder` panggil `posWriteFailoverWindowId(tx, …, {failover:"core"})` dan bandingkan dengan `locked.pos.failoverWindowId`. Test: refund tertahan vs start return paralel.

## P3
- `edge-failover.service.ts:573`: order lunas masuk `unpaidOrderIds`; pakai field `orderIds`.
- `:428`: parked order cloud saat window tidak dihitung kerja terbuka.
- `:739`: event penutup hanya ke primary saat return; ganti primary di tengah = window tertahan `returning`.

## Keputusan CTO 27 Nov
- Deviasi diterima: cancel ditolak bila ada order/shift failover; struk cek di rute (nomor dialokasikan di transaksi yang memegang `FOR SHARE`; test race F2 diulang di int sesudah F2+F3 digabung); daftar window butuh izin manage.
- Refund order failover sesudah kembali ke edge ditolak untuk v1 (tidak ada yang dibayar lebih). Bead jalur refund lewat back office; dilaporkan ke founder sebagai batasan.
- P3 parked: masuk daftar kerja terbuka (paling ketat). P3 `orderIds`: dibetulkan sekarang. P3 primary baru: bead F4/F7.
- F6b: kasir membaca status lewat endpoint baca sempit (izin jual, hanya `{id, status}`).

## Re-review 27 Nov (ba3b91f97): LULUS
- P2 kill switch: jalur `finish` hanya untuk baris window aktif; pembuatan baru ditolak di transaksi (`FINISHING_OPERATIONS`).
- P2 kunci window: `FOR SHARE` sesudah `lockPosOrder` di `pos-order-corrections.ts:222` dan `pos-payment-intent-resolve.ts:281`; race refund vs return diuji.
- P3 `orderIds` dan parked: beres.
- P3 baru (bead): `payment-va-release.ts:324` tidak cek window di transaksi; test kill switch membatalkan order lewat SQL, bukan route void.
- Syarat rilis: sesudah F2+F3 di int, jalankan `edge-failover.test.ts` dan `edge-failover-receipt.test.ts` lewat heavy (masuk gate gabung F3).
- Migrasi dinomori ulang 0532 (a41ca1bb4).
