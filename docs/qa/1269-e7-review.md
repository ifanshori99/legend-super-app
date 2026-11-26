# Review K E7 route ECR lokal (ws/1269-e7 435856f1c)

Reviewer: architect (Opus), 27 Nov. Baca kode saja. Hasil: **LULUS**, 0 P1, 2 P2 (celah test), 2 P3. Perbaikan dicek CTO, tanpa review architect ulang.

## Aman (test B baris 64)
- Balasan hilang: kunci sama mengulang permintaan asli (e7-3); balasan terminal hilang = `unknown`, sale kedua dan tunai 409 (e7-4).
- Tidak ada perintah cloud yang bisa terlambat: agent jalan di proses edge.
- Tender lain menyalip ditolak `assertNoOpenEdcRequest` (`pos-order-payment.ts:298`, `pos-order-support.ts:433`).
- Nominal dari klien ditolak 422; agent `EDC_AMOUNT_MISMATCH`; pembukuan `pos-edc-tender.ts:71`.
- Restart dan event ganda: test lama `edc-agent.test.ts:703,854`, `edge-edc-ledger-applier.test.ts:450,474,504`.
- PAN disamarkan; production tanpa adapter = 503, `ecrEnabled` false, simulator ditolak.
- Izin `requireOutletPermission`, cek ulang di agent, outlet lain 404.

## Temuan
1. P2 `test/pos-edc-routes-1269-e7.test.ts`: test negatif route: tanpa `pos.payment.accept` = 403 tanpa baris ledger; id transaksi outlet B lewat path outlet A = 404; route cancel (`pos-edc.routes.ts:99`) diuji.
2. P2 file sama: dua kunci berbeda untuk satu tagihan berpacu lewat route = satu sale, lainnya 409.
3. P3 `edge/edc/runtime.ts:69`: `setEdgeEdcAgentForTests` dijaga `NODE_ENV==="test"`.
4. P3 `services/pos-edc-request.service.ts:64-77`: baca ulang kunci tambah `eq(outletId)`.
