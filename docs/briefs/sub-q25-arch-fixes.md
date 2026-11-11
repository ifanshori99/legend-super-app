# Perbaikan review architect xhigh atas diff gabungan Q25 (HEAD acf82fac)

Akar: tiga "ruang" terpisah (rantai tukar, order POS, baris POS); tiap jalur bayar hanya melihat sebagian yang sudah diberikan. Perbaikan: SATU sumber "sudah diberikan" per baris asli dan per order di `services/order-given.ts` (`orderGivenOf`): voucher (selisih + maaf, tanpa dobel), refund recovery hidup terbesar per issue, refund POS (yang menyebut baris -> baris itu; tanpa baris -> hanya order), charge `paid`. Semua jalur bayar memotong ke `min(ruang baris, ruang order)`; ruang baris = nilai dibayar baris (tersimpan `paid_value_idr` terkecil rantai, else dihitung dari order) + extra dibayar - diberikan baris.

| # | Sev | Lokasi | Masalah -> perbaikan |
|---|---|---|---|
| 1 | HIGH | `order-recovery-refund.ts:530` | Cap refund hanya bila tukar menyimpan `paidValueIdr`. Baris tanpa tukar: voucher 8.085 lalu refund manual baris sama membayar 8.085 lagi (16.170). -> Selalu cap ke ruang baris (`wanted` atau `replay.amountIdr` - diberikan), juga ruang order. |
| 2 | HIGH | `order-recovery.service.ts:1251`, `order-recovery-paid-value.ts:720` | Credit tukar tidak dicek ke ruang order: refund POS penuh 49.665 lalu tukar kopi->air memberi voucher sampai 23.875. -> `swapPaidValueOf` kembalikan ruang order (kunci order sama); credit = min(credit, ruang); juga di preview. |
| 3 | HIGH | `order-recovery-paid-value.ts:636` | Ruang voucher per item mengabaikan refund POS yang menyebut baris. -> Atribusi `lineRoomIdr` pindah ke `order-given.ts`; refund POS baris masuk `givenIdr`. |
| 4 | HIGH | `pos-order-corrections.ts:843` | Cap baris POS dilewati di order promo: voucher kopi + refund POS kopi membayar kopi penuh lagi. -> `owedIdr = min(max(0, dueBill - Σ diberikan baris yang disebut), ruang order)` juga untuk promo. |
| 5 | MED | `pos-order-corrections.ts:866` | `depositOwedIdr` memasukkan bagian yang sudah jadi voucher. -> hitung dari `min(dueBill, max(0, paid - refunded))`. |
| 6 | LOW | `order-recovery-refund.ts:580` | Sisa pajak/service hanya mengurangi `order.refunded` dari issue recovery. -> hitung semua `order.refunded` hidup order kecuali issue ini. |
| 7 | LOW | `order-recovery.service.ts:1251` | Tukar ulang baris dengan extra di-waive ke harga daftar sama menagih ulang yang di-waive. -> tukar lebih mahal diukur ke total daftar baris; harga turun hanya untuk credit. |
| 8 | LOW | `order-recovery-paid-value.ts:453` | Tukar lebih mahal yang charge-nya diblok (tanpa baris charge) memblok tukar selamanya. -> perlakukan sebagai waived. |
| 9 | cek | preview | Dry-run promo preview mengunci baris promo tanpa kunci issue/order; pastikan `crm-promo-refund.ts:299` tidak mengunci `orders` setelah baris promo (deadlock dengan consumer). Bila ya, preview tanpa kunci (baca saja). |

Kunci tetap: issue -> order -> intent -> promo. `orderGivenOf` tanpa kunci (dipanggil di bawah kunci order).
Test baru: `apps/api/src/test/order-recovery-q25-given.test.ts`, skenario angka di tabel (1-5, 7, 8), invarian: per baris dan per order, voucher + refund recovery + refund POS <= dibayar (+ extra dibayar).

## Verifikasi architect atas 783f6ad9 (baris 10-12)

Baris 1-3, 6-8 tertutup. Sisa:

| # | Sev | Lokasi | Masalah | Fix |
|---|---|---|---|---|
| 10 (ex-4) | HIGH | `pos-order-corrections.ts:816` (`dueBill` :803) | `dueBill` kumulatif (`paidIn - refunded - kept`), tetapi yang dikurangi hanya voucher + refund recovery baris yang disebut di permintaan INI. Contoh: kopi 28.875 + voucher 20.000, roti R, item disimpan X >= 20.000. Refund 1 kopi bayar 8.875 (benar). Refund 2 hanya roti: due = 20.000 + R, room = R + X, bayar 20.000 + R. Roti dibayar 20.000 lebih, outlet rugi 20.000. | Kurangi recovery-given untuk SETIAP baris asal yang pernah dikembalikan: baris di baris refund POS sebelumnya + permintaan ini, tiap baris sekali. |
| 11 (ex-5) | MED | `pos-order-corrections.ts:853` | `depositOwedIdr` memakai `dueBill`, bukan due yang sudah dikurangi; audit menyebut deposit berutang uang yang sudah jadi voucher (28.875, bukan 8.875). | `dueIdr - min(dueIdr, max(0, paid - refunded))` dengan `dueIdr` hasil baris 10. |
| 12 | LOW | `order-recovery-paid-value.ts:436` | Tukar ulang membaca baris charge yang tidak ada sebagai waived, tetapi event yang datang kemudian (koreksi jumlah + event dikirim ulang) masih bisa membuka charge untuk baris yang sudah ditukar. | Saat tukar ulang membaca charge hilang sebagai waived: insert baris charge `waived` `ON CONFLICT DO NOTHING`, di bawah lock issue lalu order. |

Test wajib (gagal-dulu di 783f6ad9, tambah ke `order-recovery-q25-given.test.ts`):
- Baris 10: kopi + voucher 20.000 direfund dulu, lalu refund yang hanya menyebut roti membayar paling banyak bagian roti; total voucher + refund <= dibayar; item yang disimpan tidak tersentuh.
- Baris 11: audit `depositOwedIdr` = 8.875 pada skenario di atas saat tender habis.
- Baris 12: tukar ulang tanpa baris charge, lalu event charge datang terlambat: tidak ada charge terbuka untuk baris yang sudah ditukar.
