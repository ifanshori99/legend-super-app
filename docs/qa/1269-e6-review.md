# Review K E6 refund sale edge dari back office (ws/1269-e6 de745127c)

Reviewer: architect (Opus xhigh), 27 Nov. Baca kode saja. Hasil: **GAGAL**, 1 P1, 4 P2, 4 P3.

## Aman
Refund ganda (kunci sama replay, kunci lain dihitung termasuk `requested`), lebih dari bayar ditolak; RRN dinormalisasi + unik DB + dicek ke struk; void sesudah bayar ditolak; tender gateway ditolak; MFA; tenant/outlet/order lain 404; 0533 RLS + trigger final + unik RRN/referensi.

## P1
1. Refund `requested` sudah dihitung sebagai refund (melanggar D1). `pos-day.service.ts:763-801` mode `edgeComparable` ikut baca refund back office -> `edge/shift-day-applier.ts:1003-1004` `Waiting("recap_differs")` selamanya, Tutup Hari edge macet. Mode cloud hitung tunai keluar pada tanggal permintaan, jurnal baru saat settle (`pos-order-corrections.ts:1957`). Sama di `metric-sources/sales.ts:91,196`, `pos-shift-print.ts:136-142`. Perbaikan: `edgeComparable`/`edgeMirror` abaikan refund yang punya `pos_refund_payouts`; cloud + metrik hanya `succeeded` bertanggal `settled_at`. Test: Tutup Hari edge tersimpan walau ada refund requested/succeeded; rekap cloud 0 selama requested, terhitung pada tanggal settle.

## P2
2. Settle tanpa `assertBusinessDayOpen` (`pos-order-corrections.ts:1785-1957`). Test: settle sesudah Tutup Hari ditolak.
3. Referensi tunai tidak dinormalisasi (`packages/shared/src/pos/schemas.ts:1004`, `pos-order-corrections.ts:1854`, index 0533): satu transfer bisa bayar dua refund. Normalkan seperti RRN. Test ejaan lain ditolak.
4. Jalur `pos-edge-outlet.ts:269` belum diuji sukses dengan edge primary aktif. Test: edge primary + sale ingested, refund lalu settle `succeeded`; order seri F ditolak di service.
5. Jurnal belum diuji (`accounting-auto-journal-amounts.ts:2989-2994`, `posting-rules.ts:230,280`). Test: bank/kas kecil dikredit, `cash_on_hand` 0, campuran EDC, tenant tanpa mapping akun.

## P3 (bead lanjutan)
6. `WeakSet` penanda tx -> `WeakMap<tx, orderId>`.
7. `order.voided` edge lama ditolak `refund_exists` tidak masuk finance exception; settle tidak cek `void_refused:%`.
8. Settle tanpa penjaga mode edge; DTO `PosRefund` tanpa status payout.
9. 0533 tanpa FK komposit order/outlet di payout.

## Tindak lanjut
Engineer Sonnet (agent E6) urut: P1, P2 2-3, test 4-5. Re-review cukup diff perbaikan. Ditunda: kuota habis 27 Nov.
