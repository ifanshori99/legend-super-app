# Review K C3a kasir cloud VA/e-wallet (ws/1272-c3a d90a6494a)

Reviewer: architect (Opus, xhigh), 27 Nov. Baca kode saja. Hasil: **LULUS**, 0 P1, 1 P2, 3 P3. P2 dibetulkan sebelum gabung, dicek CTO.

## Aman
- Satu kode hidup per tagihan; kode baru 409 (`pos-order-payment.ts:565-578`, `:375`).
- Tunai/QRIS/poin/EDC manual ditolak selama kode hidup; buka lagi hanya bila Duitku `02` sesudah kedaluwarsa + 60 dtk (`pos-qris-hold.ts:1064-1072`); `01`/timeout tetap mengunci.
- Callback telat sesudah rilis manager (>= 30 menit sesudah kedaluwarsa) diparkir sebagai dana belum teralokasi (test:468).
- Umur kode 10 menit (`pos-qris-hold.ts:520`), expiry Duitku dibulatkan ke bawah (`payment-duitku.ts:485`).
- Nominal = sisa tagihan dari server; kanal dicek ke daftar Duitku pada nominal itu; callback nominal beda diparkir.
- Edge ditolak sebelum tautan/Duitku (`:584`). Nomor VA hanya untuk yang boleh terima bayar; query tersaring tenant.

## P2
- `payment-va-release.ts:144-186`: `va/release` lama bisa merilis VA kasir yang masih ditahan -> dua jalur rilis; bayar sah sesudahnya diparkir, tagihan tersangkut. Fix: tolak `VA_RELEASE_NOT_ELIGIBLE` bila penahanan `open`/`cancelling`, arahkan ke `qris/release`. Test: VA kasir tertahan -> `va/release` 409, tanpa baris rilis VA.

## P3
1. Test POST tender VA/e-wallet dengan `EDGE_MODE=true` -> 409 `QRIS_NEEDS_CLOUD`, Duitku tidak dipanggil.
2. `pos-order-payment.ts:651-655`: gateway cadangan bisa menerbitkan VA bukan Duitku.
3. `:592`: daftar metode Duitku diambil dua kali (kinerja saja).

## Keputusan CTO 27 Nov
- Umur kode kasir VA/e-wallet 10 menit diterima (pelanggan butuh waktu membuka aplikasi bank); QRIS tetap 5 menit.
- P2 + P3 1 + P3 2 dibetulkan sebelum gabung. P3 2: paling ketat, kasir VA/e-wallet menolak bila routing memilih penyedia selain Duitku (tanpa cadangan). P3 3: boleh ditunda.
- Gerbang C1 sandbox: buktikan Duitku menjawab `02` untuk VA kedaluwarsa. Bila tidak, rilis manager jadi jalur normal: catat sebagai temuan rilis.
