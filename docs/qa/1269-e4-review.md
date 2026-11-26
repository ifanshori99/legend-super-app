# Review K E4 ledger EDC edge (ws/1269-e4)

Reviewer: architect (Opus), 27 Nov. Hasil: **LULUS**, 0 P1, 0 P2, 6 P3.

Migrasi dinomori ulang ke 0530 (sesudah 0529 F1) saat merge rc2, commit 51b540ede. Isi SQL sama, termasuk RLS dan trigger.

## Temuan P3 (tidak menahan merge)
1. Event edge versi lama ditolak permanen. Naik jadi P2 bila saat rilis masih ada edge lama di lapangan.
2. Penolakan sesudah `created` sudah dicerminkan meninggalkan baris cloud `pending` selamanya (E6).
3. Rekonsiliasi cloud masih bisa mengubah baris edge (E6).
4. Penjualan edge yang disetujui tanpa tender terkait membuat `hasOpenEdcRequest` tetap true (E6/E9).
5. RRN tidak valid dibuang diam-diam di edge.
6. Belum ada test untuk alert supervisor dan untuk PAN lewat jalur konflik link.

## Tindak lanjut
- P3 no. 2-4 dicatat di bead legend-osqou.27 (E6).
- No. 1 dicek ulang sebelum gerbang rilis.
