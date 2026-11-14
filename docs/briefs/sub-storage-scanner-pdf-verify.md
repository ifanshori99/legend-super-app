# Verifikasi M4+M5 (test-runner, pemegang token heavy satu-satunya)

Root: `/Users/ifanshori99/Projects/legend super app/legend-294a6ef0`. Satu perintah per panggilan Bash, berurutan (jangan paralel). Laporkan perintah + hasil ringkas; kegagalan dengan 30 baris log relevan.

1. Test terarah (dari root):
   `LEGEND_TEST_FILES="src/test/clamd-scanner.test.ts src/test/core-image-scanner-fail-open.test.ts src/test/health-scanner.test.ts src/test/http.test.ts src/test/core-image.test.ts src/test/pdf-safety.test.ts src/test/core-storage-pdf-safety.test.ts src/test/core-storage-pdf-scanner.test.ts src/test/menu-print-db.test.ts src/test/menu-import-storage-wire.test.ts src/test/hris-scheduling-swap-api.test.ts src/test/hris-attendance-selfie-bind.test.ts" heavy pnpm test`
2. Prettier (dari root): `pnpm exec prettier --check` + semua file berubah/baru di `git status --short` (kecuali docs/briefs).
3. ESLint (dari root): `pnpm exec eslint` + file .ts berubah/baru di apps/api.
4. Typecheck API: `heavy pnpm --filter @starter/api typecheck` (cek nama script di apps/api/package.json; bila tidak ada, `heavy pnpm --filter @starter/api exec tsc --noEmit`).
5. Build API: `heavy pnpm --filter @starter/api build`. Lalu pastikan `apps/api/dist/pdf-safety.worker.js` ada, dan `grep -l "pdf-safety.worker" apps/api/dist/*.js`.
6. Smoke worker produksi: tulis skrip di scratchpad `/private/tmp/claude-501/-Users-ifanshori99-Projects-legend-super-app-legend-294a6ef0/82316c12-14fd-456b-9fa7-bbdc99a7f6db/scratchpad/smoke-worker.mjs` yang membuat PDF sah dengan pdf-lib (import dari `apps/api/node_modules/pdf-lib`) lalu `new Worker(<abs path dist/pdf-safety.worker.js>, { workerData: { bytes } })` dan cetak pesan verdict (harus `{ ok: true, pageCount: 1 }`), juga untuk PDF dengan `/OpenAction` JavaScript (harus `ok:false`). Jalankan `node <skrip>` dari folder `apps/api`.
7. `git status --short` setelahnya: pastikan build tidak meninggalkan berkas ter-track yang berubah.
