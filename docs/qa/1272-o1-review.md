# Review K O1 bekal offline (ws/1272-o1 07483f6b8)

Reviewer: architect (Opus xhigh), 27 Nov. Baca kode saja. Hasil: **LULUS**, 0 P1, 1 P2, P3.

## Aman
Prefix L tidak dipakai ulang (kunci outlet `pos-receipt.service.ts:154`, cari prefix bebas termasuk pensiun `:204,:468`, unik, trigger, skema bersama); run biasa mengecualikan seri `offline` (`:178`); epoch hanya lanjut dengan run aktif perangkat sendiri; izin `shift.cash.operate` + perangkat + kasir + shift open; 0533 NO FORCE sebelum preflight, RLS, append-only, snapshot cocok; DTO strict tanpa HPP.

## P2
Kit bisa terbit di proses edge (`edge/mode.ts:94`, `pos-edge-outlet.ts:176-180`). Tolak bila `isEdgeProcess()` di awal `issuePosOfflineKit` (`pos-offline-kit.service.ts:72`); filter `ne(series,'offline')` di `localReceiptRunReport` (`pos-receipt.service.ts:1498-1507`). Test: edge mode = tolak, tanpa baris `offline`.

## P3
1. Katalog dibaca di luar transaksi sebelum cek shift (`pos-offline-kit.service.ts:80-85`): pindah sesudah cek shift.
2. Snapshot penuh per terbitan tanpa batas epoch. Keputusan CTO: batas epoch baru per perangkat (maks 6 per jam, lebih = 429) sekarang; dedupe snapshot per (outlet, catalog_version) jadi bead.
3. Test: preflight 0533 tolak bila ada `L5`; shift closed sungguhan; resume dengan run sendiri yang pensiun; tanpa `shift.cash.operate`; rute HTTP trusted origin.
4. Untuk O2: ingest wajib menerima penjualan pada run `offline_epoch` yang sudah pensiun (dua permintaan null bersamaan bisa memensiunkan run yang dipakai tablet).
