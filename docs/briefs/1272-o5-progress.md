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

## Keputusan CTO O5 (27 Nov, sesudah laporan 1)
1. e2e browser: config terpisah `playwright.offline.config.ts` meniru produksi (API `http://api.legend.test:4101`, build web `VITE_API_URL=http://api.legend.test:4101`, `COOKIE_DOMAIN=.legend.test`, Chromium `--host-resolver-rules="MAP *.legend.test 127.0.0.1"`, buka `http://<slug>.legend.test:3101/pos/kasir`; seed tenant_domains seperti pos-real). Env tambahan hanya di config e2e. Berhenti dan lapor penyebab persis bila buntu sesudah 1 percobaan nyata.
2. `fetchOpenShiftsOfDay`: filter opsional `status` di API daftar shift + web memakainya + semua halaman.
3. Gagal-dulu API: implementasi API (1) dan (2) dibalik sementara, test dijalankan, dipulihkan.

## Hasil keputusan 2 dan 3
- API: `listPosShifts` query `status` (open|closed, strict zod, opsional). Web kirim `status=open`, tanpa businessDate, semua halaman.
- Gagal-dulu (implementasi API dibalik): pos-offline-batch "O5 (1)" GAGAL (flag/alasan tidak dikenal, skema strict menolak); pos-shift "O5 (2)" GAGAL (`expected 422 to be 200`, status ditolak). Dipulihkan: pos-offline-batch 26 lulus, pos-shift 88 lulus, web o5 6 lulus.
- Catatan: guard DB melarang mengubah business_date shift, jadi test API tidak memundurkan tanggal; "tanpa batas hari" dibuktikan lewat daftar tanpa businessDate + gabungan status=open&businessDate=lain kosong.

## Langkah 4: harness e2e offline (27 Nov)
- Dibuat: `playwright.offline.config.ts`, `e2e-offline/pos-offline.spec.ts`, mode `e2e-offline` di `scripts/test.mjs` (API `api.legend.test:4101`, web `o5-offline.legend.test:3101`, `COOKIE_DOMAIN=.legend.test`, `LEGEND_E2E_SKIP_BUILD=1` untuk iterasi spec).
- Percobaan 1 gagal: API `NODE_ENV=development` crash (pino-pretty worker, `__dirname` di bundle ESM). Dipindah ke `NODE_ENV=test` (tanpa pretty, aturan https produksi tak disentuh). Web tetap production.
