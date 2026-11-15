# Verifikasi M6 (test-runner, satu-satunya pemegang token heavy)

Root: `/Users/ifanshori99/Projects/legend super app/legend-294a6ef0`. Satu perintah per Bash, berurutan. Laporkan perintah + hasil; gagal dengan 30 baris log.

1. Test API terarah (dari root): `LEGEND_TEST_FILES="<daftar>" heavy pnpm test`, daftar = `src/test/payout-evidence-shared-scanner.test.ts src/test/storage-capabilities.test.ts` + semua `src/test/payroll-payout-*.test.ts` (ls dari apps/api) + `src/test/core-storage-pdf-safety.test.ts src/test/core-storage-pdf-scanner.test.ts src/test/pdf-safety.test.ts src/test/core-image.test.ts src/test/core-image-scanner-fail-open.test.ts src/test/shareholder-documents.test.ts src/test/shareholder-documents-wire.test.ts src/test/shareholder-membership-latest-version.test.ts src/test/http.test.ts`.
2. Test root kontrak teks: `heavy pnpm test` TIDAK; pakai yang dipakai implementer web untuk `tests/text-contract.test.mjs` (cek `package.json` root untuk cara aman menjalankan satu test root; bila hanya lewat `pnpm test` penuh, lewati dan laporkan).
3. Prettier: `pnpm exec prettier --check` semua file berubah/baru di `git status --short` (kecuali docs/briefs).
4. ESLint: `pnpm exec eslint` semua .ts/.tsx berubah/baru.
5. Typecheck berurutan: `heavy pnpm --filter @starter/api typecheck`, lalu `heavy pnpm --filter @starter/shared typecheck` (bila script ada), lalu `heavy pnpm --filter @starter/web typecheck` (cek nama script).
6. `heavy pnpm --filter @starter/api build` exit 0.
7. `git status --short` akhir.
