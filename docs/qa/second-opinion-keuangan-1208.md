# Second opinion akuntansi + HPP (1208, 20 Nov, architect, int/batch100)

Verdict: TIDAK (1 P1 uang)

## P1 Bagi hasil outlet tidak memasukkan gaji -> pemegang saham outlet bisa dibayar lebih
- `apps/api/src/services/payroll-gl-consumer.ts:385,434`: jurnal payroll locked/paid selalu `outletId: null` (payroll_runs per entitas, tanpa outlet). Baris mewarisi null (`accounting-journal.service.ts:703`).
- `apps/api/src/services/profit-share-net-profit.ts:58-95`, `packages/shared/src/accounting/statements.ts:91`: entitas laba outlet (`profit-share-distribution.service.ts:904-908`) hanya menghitung baris bertag outlet itu; baris level entitas dilewati.
- Contoh: outlet A penjualan 100 jt, HPP 40 jt (bertag A), gaji staf 30 jt (level entitas). Laba nyata 30 jt, distribusi dihitung 60 jt -> bagi hasil 2x. P&L per outlet (ACC-03) ikut menggelembung. Service charge sebagai pendapatan bertag outlet, pembayarannya ke staf lewat payroll level entitas -> makin menggelembung.
- Usulan: (1) fail closed sekarang: tolak distribusi entitas outlet selama periode punya baris beban level entitas yang tidak dialokasikan, dengan alasan jelas; test. (2) jangka panjang: tag baris jurnal payroll per outlet (per outlet karyawan) atau aturan alokasi overhead (keputusan bisnis founder).

Tertutup dari SO lama: pembulatan retur pembelian (`purchase-return.service.ts:998-1024`), lookup finance exception membaca `pos_order_tenders` (`accounting-finance-exceptions.service.ts:405-437`).
Dicek tanpa masalah: jurnal tak seimbang ditolak DB (0027), posting ke periode tutup ditolak (0268), laporan satu snapshot, distribusi basi saat periode dibuka ulang (`profit-share-distribution.service.ts:1444`), HPP waste/opname/penjualan sesuai nilai baris stok.
Belum diperiksa: HPP saat avg cost 0 atau stok negatif (koreksi belakangan?), buka ulang periode sesudah distribusi dibayar, detail `hpp-report.service.ts`, `accounting-auto-journal-amounts.ts`, `purchasing-receipt-journalize.service.ts`, `accounting-tax-*`, depresiasi per outlet (`accounting-fixed-assets.service.ts:486`).

## Keputusan CTO 20 Nov
- P1 langkah 1 (fail closed) dikerjakan kartu 1210 sekarang: membatasi pembayaran, outlet tidak rugi.
- Langkah 2 (alokasi gaji per outlet) = keputusan bisnis, dibawa ke founder. Usulan CTO: gaji dibebankan ke outlet tempat karyawan terdaftar; staf lintas outlet / kantor pusat dibagi proporsional penjualan.
- "Belum diperiksa" HPP avg cost 0 / stok negatif + buka ulang periode sesudah dibayar: masuk SO lanjutan bersama area E (inventori).
