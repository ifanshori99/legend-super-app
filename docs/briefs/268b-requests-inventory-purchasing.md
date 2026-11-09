# Permintaan berkas bersama: inventory-purchasing (F5)

1. `apps/api/src/services/metrics-gl-sources.ts`: keluarkan `stock_value`, `purchase_total`, `supplier_due` dari `NON_GL_MONEY_METRICS` (kini dibaca reader `daily`, alasan di komentar `metric-sources/inventory-purchasing.ts`). `test/metrics-runtime.test.ts` ("every rupiah metric is ledger-mapped or listed as NON_GL") harus disesuaikan pemilik berkas: metrik uang `daily` tidak lagi wajib ada di salah satu daftar. Belum diubah, test itu masih lulus.
2. Benturan klaim: `supplier_due` juga dipakai laporan `finance.supplier_due` (F6). Hanya satu keluarga boleh mengklaim kodenya (registry melempar saat dobel). Diklaim di F5; F6 jangan klaim ulang.
3. `cogs`: tetap GL di `gl.ts`; pecahan menu/kategori `cogs` milik F3 (menu-cogs), tidak dibuat di F5.
