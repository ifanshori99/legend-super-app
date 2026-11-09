# Permintaan berkas bersama: inventory-purchasing (F5)

1. `apps/api/src/services/metrics-gl-sources.ts`: keluarkan `stock_value`, `purchase_total`, `supplier_due` dari `NON_GL_MONEY_METRICS` (kini dibaca reader `daily`, alasan di komentar `metric-sources/inventory-purchasing.ts`). `test/metrics-runtime.test.ts` ("every rupiah metric is ledger-mapped or listed as NON_GL") harus disesuaikan pemilik berkas: metrik uang `daily` tidak lagi wajib ada di salah satu daftar. Belum diubah, test itu masih lulus.
2. Benturan klaim: `supplier_due` juga dipakai laporan `finance.supplier_due` (F6). Hanya satu keluarga boleh mengklaim kodenya (registry melempar saat dobel). Diklaim di F5; F6 jangan klaim ulang.
3. `cogs`: tetap GL di `gl.ts`; pecahan menu/kategori `cogs` milik F3 (menu-cogs), tidak dibuat di F5.

## Risiko performa dan seam (review architect)

- `stock_value` dan `critical_stock_count` untuk hari lampau memutar ulang `stock_ledger` outlet di JS per hari. Backfill 365 hari berarti 365 putaran. Usul: snapshot stok harian atau lipat satu kali per rentang di `recomputeMetricsDaily` (berkas bersama).
- `DailyComputeInput` tidak membawa `now`, jadi pilihan jalur hari berjalan memakai `Date.now()`. Usul: tambah `now` di `types.ts` (berkas bersama).
- `supplier_due` tidak memuat invoice tingkat badan usaha (tanpa outlet); `supplier_due` juga dipakai `finance.supplier_due` (F6), F6 tidak boleh mengklaim ulang kodenya.
