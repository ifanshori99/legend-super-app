# Audit V1 poin, voucher, DP kasir cloud (int/rc2 16b189ad2)

Auditor: architect (Opus, xhigh), 27 Nov. Baca kode saja. Hasil: 0 P1, 0 P2, 2 P3.

## Aman
- Poin: nilai dari server (`pointValueIdr`), maks sisa tagihan; kunci member + baca ulang saldo; QR member sekali pakai dan ditolak bila saldo berubah; tidak di edge/offline/latihan; void poin kembali ke lot asal; refund/void bill berpoin ditolak; tidak dapat poin dari bagian bayar poin (`loyalty-earn-consumer.ts:420`).
- Voucher: `FOR UPDATE` + issued->redeemed berpenjaga (`crm-promo-engine.ts:1471-1482`); diskon <= sisa tagihan, total tidak di bawah uang diterima; refund mengembalikan voucher hanya bila diskon tidak lagi dipegang (`crm-promo-refund.ts:690-768`).
- DP: kunci sesi sama kasir + QR, hitung DP terpakai order lain (`pos-order-support.ts:1054-1082`); gabung meja/pindah item/void sesudah bayar ditolak bila ada DP; refund DP hanya ke pembayaran asal (`reservation-deposit-credit.ts:465-477`).

## P3
1. `pos-order-discounts.ts:234` kirim `customer: null`: voucher member dan kuota per pelanggan selalu ditolak di kasir. Fix: kirim `order.customerProfileId` hanya bila member dipasang lewat QR member/sesi aplikasi (ketik HP tetap null). Test: QR A diterima, HP A ditolak, member B ditolak.
2. `pos-order-corrections.ts:1077-1079, 1112-1115, 1423-1428`: `paid` ikut tender poin lama tanpa baris potong poin -> refund bisa bayar tunai senilai poin. Fix: `nonPointsPaid` untuk `paid`, `roomIdr`, `assertRefundWithinPaid`. Test: tender poin tanpa ledger, refund penuh <= bagian non-poin.

## Keputusan CTO 27 Nov
- Kedua P3 dikerjakan sekarang (P3 2 = jangan sampai rugi). Belum dicek: refund DP dari pembatalan reservasi saat DP dipakai order (`depositInUseOfIntent`): ikut dicek di kartu yang sama dengan test.
