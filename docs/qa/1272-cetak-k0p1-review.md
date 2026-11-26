# Review K K0+P1 cetak cloud (ws/1272-cetak 2b1c0ad5a)

Reviewer: architect (Opus high), 27 Nov. Baca kode saja. Hasil: **LULUS**, 1 P2 wajib sebelum P2 web disambung.

## Aman
K0: POST `/api/edge-nodes` 403 FEATURE_DISABLED tanpa tulis (`edge-nodes.routes.ts:153`); `ensureLocalEdgeNode` hanya di edge lokal; rotate hanya baris active, tidak ada activate. Tiga endpoint cetak: izin + outlet/tenant aman. Laporan shift hanya supervisor bukan kasir shift itu (`pos-shift.service.ts:474`), shift buka 409. Delivery idempoten per kunci.

## P2
`pos-receipt-delivery.service.ts:453-456`: kirim ulang kunci cetak pertama membuat byte "asli" baru tanpa tanda CETAK ULANG, tanpa baris delivery, reprintCount tetap. Perbaikan: `!created` = `markReprint` + `reprint:true`. Test di `pos-receipt.test.ts`: kunci sama -> "CETAK ULANG", delivery 1, reprintCount tetap.

## P3
- Laporan shift dan tiket dapur lewat GET selalu `reprint:false`. Keputusan CTO: bead (legend-wasr7.4 P3 dapur) — risiko uang rendah.
- Test: supervisor (`approve_close`) yang juga kasir shift itu = 403 (`pos-shift-print-928.test.ts`).
