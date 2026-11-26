# O5 legend-wasr7.9 progress

## Langkah 1 (27 Nov): test gagal-dulu
- Dibuat: apps/web/test/pos-offline-o5.test.ts (guard "pelanggan lain", fetchOpenShiftsOfDay semua halaman, saveOfflineSale).
- Ditambah: test antrean di apps/web/test/pos-offline-queue.test.ts; 2 test API di apps/api/src/test/pos-offline-batch.test.ts (flag other_customer).
- Rancangan wajib rilis (1): event offline dapat `otherCustomerReason` (4-200 huruf, opsional) -> flag baru `other_customer` di jsonb flags (tanpa migrasi) -> alert `offline_sale.review_needed` ke supervisor memuat alasan. Uang tetap masuk laci shift (bukan shift_closed).
- Rancangan wajib rilis (2): fetchOpenShiftsOfDay tanpa businessDate, ikuti nextCursor sampai habis, saring open.
- Belum: implementasi, e2e browser nyata, screenshot, drill.
