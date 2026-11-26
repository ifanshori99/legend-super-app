# O5 legend-wasr7.9 progress

## Langkah 1 (27 Nov): test gagal-dulu
- Dibuat: apps/web/test/pos-offline-o5.test.ts (guard "pelanggan lain", fetchOpenShiftsOfDay semua halaman, saveOfflineSale).
- Ditambah: test antrean di apps/web/test/pos-offline-queue.test.ts; 2 test API di apps/api/src/test/pos-offline-batch.test.ts (flag other_customer).
- Rancangan wajib rilis (1): event offline dapat `otherCustomerReason` (4-200 huruf, opsional) -> flag baru `other_customer` di jsonb flags (tanpa migrasi) -> alert `offline_sale.review_needed` ke supervisor memuat alasan. Uang tetap masuk laci shift (bukan shift_closed).
- Rancangan wajib rilis (2): fetchOpenShiftsOfDay tanpa businessDate, ikuti nextCursor sampai habis, saring open.
- Belum: implementasi, e2e browser nyata, screenshot, drill.

## Langkah 2 (27 Nov): wajib rilis (1) dan (2) selesai
- (1) shared: `otherCustomerReason` + flag `other_customer`; API ingest memberi flag dan alert ke supervisor dengan alasan; web: guard, dialog "Ini pelanggan lain", antrean membawa alasan. Uang: replay tetap `duplicate`, kas tetap di laci shift terbuka.
- (2) fetchOpenShiftsOfDay: semua halaman, tanpa businessDate.
- Test terarah hijau: o5 (web), queue, o4-detect/review/ui, pos-offline-batch (API 26). Prettier, eslint, text-contract hijau.
- Berikut: typecheck api+web, e2e browser nyata, screenshot, drill.

## Langkah 3 (27 Nov)
- Typecheck api 0 error, web 0 error (heavy). Drill ditulis: docs/qa/1272-o5-drill.md.
- e2e browser nyata TERHENTI (butuh keputusan CTO), lihat laporan: browser harus bicara ke web+API lewat host tenant (`<slug>.legend.test`), padahal build e2e menanam VITE_API_URL=localhost:4101 (lintas situs, cookie SameSite tidak ikut), guard `/pos/kasir` (context.access) diambil per host, token perangkat dan service worker offline di build produksi. Tidak dibuat spec rapuh.
