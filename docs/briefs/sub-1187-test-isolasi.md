# sub-1187: isolasi test untuk 2 worker vitest

Cabang `ws/1187-test-isolasi`, base m1 (2b23b324f). Tingkat S, HANYA file test/e2e. Tanpa migrasi. Jangan ubah `apps/api/src/services`, `apps/web/src/routes`, `apps/api/vitest.config.ts`.
Daftar tabrakan (dugaan, belum diverifikasi): `/private/tmp/claude-501/-Users-ifanshori99-Projects-legend-super-app-legend-f7fe0596/2a670f01-0f5b-42c2-bf7c-b7c71c59991d/scratchpad/collisions.md` (kelompok B = kartu 1, C = kartu 2).

Jangan sentuh: `payroll-payout-recon*`, test `payroll-payout-*lock*`, `reservation-*`, `payment-webhook*`.

## Potongan (file milik tidak bertumpuk)

1. `legend-vn40t`: `apps/api/src/test/hris-leave-release-event-db.test.ts`. Temukan sumber "Kuota paket sudah tercapai." (baca service yang melempar, hanya baca). Data test dibuat unik per file/tenant (tenant/paket sendiri), bukan global/dibagi.
2. `legend-xh240`: `apps/api/src/test/payroll-policy-api.test.ts` (sekitar baris 206 `legal_entities ... LIMIT 1` tanpa batas tenant). Asersi pagination dan "tenant B creates its own policy" dibatasi ke tenant/fixture milik test sendiri.
3. `legend-df7qv`: cari di `apps/api/src/test/*.ts` (kecuali daftar jangan-sentuh) pola `replace(mappings)` / pemulihan mapping kas (petty_cash/kas) yang gagal diam-diam di bawah aturan 1147 (guard menolak remap ke akun yang sudah dijurnal). Contoh benar: teardown so-f3 di `payroll-payout-870-gl-pending.test.ts` (commit ddb6da4d8 `git show ddb6da4d8`): restore langsung ke tabel. Ganti pola serupa dengan restore yang lolos aturan. Berkas milik: yang kamu temukan; laporkan daftar.
4. e2e `e2e/legend-cz9g.mock.spec.ts` baris ~144-155, 241-249, 298-304, 328-338: tambah `waitForHydration` / timeout 30s seperti bagian lain spec itu. Versi 1170 (`git show origin/ws/1170-flake-higiene:e2e/legend-cz9g.mock.spec.ts`) hanya referensi pola, jangan ambil seluruhnya.

## Aturan subagent

- Jangan menjalankan vitest/tsc/playwright (satu token heavy per thread; agent induk yang menjalankan). Boleh `pnpm exec prettier --check`/`eslint` file sendiri.
- Jangan commit. Lapor: file berubah, sebab tabrakan yang ditemukan (kutip baris), cara menjalankan reproduksi dua-file (`LEGEND_TEST_FILES="A B"`), file mana yang bertabrakan dengan file mana.
- Beda pendekatan dari dugaan di doc: ikuti kode, bukan dugaan.

## Bukti selesai

Reproduksi terarah dua file sebelum dan sesudah, prettier + eslint hijau, commit.
