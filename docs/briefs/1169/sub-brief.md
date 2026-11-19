# 1169 sub-brief: riwayat refund POS selaras largest remainder (legend-rle3t)

Base 4bfae8476. Tanpa migrasi. File sentuh: `apps/api/src/services/order-given.ts` (`lineBalancesIdr` priorPos, ~l.465-484) + test baru `apps/api/src/test/pos-refund-history-lr.test.ts` (dan test guard chain void kas).

## Aturan alokasi riwayat (keputusan CTO, membatasi bayar)
Tiap baris refund POS bernama-item (diproses kronologis, running balance per baris asli):
1. Kelompokkan entri ke baris asli (`toOriginal`); bobot = jumlah `valueOf(item, qty)` per baris asli.
2. Bagi `amountIdr` ke baris asli berdasar bobot: largest remainder (BigInt), tie-break ID baris menaik. Urutan item di request tidak berpengaruh. Bobot semua 0: bobot sama.
3. Jepit tiap debit ke ruang baris = max(0, bagian_baris - lineGiven - priorPos).
4. Sisa nominal (akibat jepit) ke baris bernama lain yang masih punya ruang (id menaik), tetap <= ruang.
5. Masih ada sisa (semua baris bernama penuh; baris lama): debit ke baris bobot terbesar (tie id menaik) agar jumlah debit = nominal refund (ruang jadi 0, tidak negatif ke baris lain).
Jumlah debit = nominal refund selalu.

## Test (gagal-dulu)
1. A 10.000 / B 20.001 / C 30.000, service 3.000, PBJT 6.300, dibayar 69.301. Voucher C Rp1, refund [A,B] Rp34.651 diterima, lalu voucher A Rp1 ditolak 422 APOLOGY_VOUCHER_NOTHING_DUE; ruang A dan B 0.
2. Sama, urutan [B,A]: hasil identik.
3. Properti: beberapa pasangan baris + voucher/refund bersamaan (barrier dua koneksi): total keluar <= dibayar, tiap baris <= bagiannya.
4. Guard chain 422 pada void kas sesudah charge keluar dari `paid` (status, movement, event ter-rollback); kontrol chain bersaldo nol sukses.
