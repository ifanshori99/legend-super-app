# Review K F5 rekap hari failover (ws/1271-f5 1c6e5fab2)

Reviewer: architect (Opus), 27 Nov. Hanya baca kode, test tidak dijalankan. Hasil: **LULUS dengan catatan**; 2 P2 wajib dibetulkan sebelum gabung.

## Aman
- Tidak dobel, tidak hilang: rekap edge tanpa baris failover, close tersimpan = edge + failover (`pos-day.service.ts:338-348`, `edge/shift-day-applier.ts:995-1015`). Test 50000 + 30000 = 80000.
- Replay idempoten (`day_already_closed`, satu baris).
- Edge Tutup Hari ditolak `FAILOVER_ACTIVE` saat jendela `active`/`returning`. Close yang datang saat jendela buka menunggu `failover_open`.
- Write-off nomor F ditolak (`pos-receipt-writeoff.service.ts:114`).

## Temuan
1. P2 `pos-day.service.ts:1215-1229`: cek gap seluruh outlet, gap F tidak bisa di-write-off, jadi satu gap F memblok semua Tutup Hari cloud berikutnya selamanya.
2. P2 (belum dicek): bila deret F disalin ke edge, cek gap edge juga memblok Tutup Hari edge. Test: Tutup Hari edge lolos saat ada gap F di cloud.
3. P3 `shift-day-applier.ts:918` + `pos-day.service.ts:892`: gap F lama terhitung ulang tiap hari.
4. P3 `pos-day.service.ts:331`: pakai `FAILOVER_RECEIPT_PREFIX_PATTERN` dari `packages/shared/src/pos/receipts.ts`.
5. P3: test penjualan failover sesudah cloud menutup tanggal itu.

## Keputusan CTO 27 Nov
1. Gap F tidak memblok Tutup Hari (saran architect). Nomor F terbit di transaksi yang sama dengan penjualan, jadi gap tidak bisa menyembunyikan penjualan berbayar. Write-off F tetap ditolak. Gap F masuk hitungan gap di rekap tanggal itu saja (bukan seluruh outlet), kirim alert owner, buat bead tim teknis.
2. Jendela override memblok tutup hari di kedua sisi: setuju. Satu sumber kebenaran per hari. Pesan cloud diganti `FAILOVER_ACTIVE`: "Selesaikan Kembali ke edge dulu, lalu Tutup Hari di kasir edge". Alert owner bila jendela masih buka dekat jam tutup: boleh kartu terpisah bila besar.
