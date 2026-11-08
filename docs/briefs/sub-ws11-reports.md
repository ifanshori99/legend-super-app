# Sub-brief WS-11 dashboard dan laporan (brief 93)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/ws11-reports`, cabang `ws/ws11-reports` (dari `milestone/m1` e4938167). Semua perintah dari folder itu. Jangan commit, jangan push: agent yang commit. Build, Playwright, e2e hanya lewat `heavy <perintah>`. Jangan matikan proses test global (pkill vitest, killall node).

PRD: `../../../PRD_Legend_Super_App_v1.7.md` baris 970–1015 (34 Owner, 35 Shareholder, 36 Manajemen; DASH-01..04, SH-01/02) dan 1509 (metrik didefinisikan sekali).

## Invarian (semua potongan)
- I1 Angka uang (penjualan bersih, HPP, biaya, laba, pajak, pembayaran, payroll) wajib sama dengan jurnal GL (`apps/api/src/db/schema/accounting.ts`: `journalEntries`/`journalLines`, periode tertutup dari `fiscalPeriodSnapshots`). Jangan hitung ulang dari transaksi mentah (order, payment). Non-uang (pax, kunjungan, durasi) boleh dari tabel operasional.
- I2 Periode tertutup = `final`; berjalan = `estimate` dan selalu berlabel estimasi (SH-02).
- I3 Shareholder tidak pernah melihat PII pelanggan/karyawan/member, gaji individu, atau bagian shareholder lain (SH-01), termasuk lewat API dan ekspor.
- I4 Dashboard == laporan sumber untuk periode dan filter sama (DASH-02). Fixtures demo harus konsisten satu sama lain.
- I5 Teks UI Bahasa Indonesia. UI baru mengikuti template viewer yang sudah ada (`apps/web/src/features/ws11-reports/route-options.tsx`); jangan buat layout baru.
- I6 Tiap potongan menulis test di berkas test BARU miliknya (nama di bawah), bukan berkas test bersama.
- I7 `packages/shared/src/dashboard/index.ts` dan `packages/shared/src/metrics/index.ts`: hanya potongan C dan E yang boleh menambah export (C: dashboard, E: metrics). `apps/api/src/app.ts`: hanya potongan D.

## Potongan

### R — halaman laporan batch A + B + drill-down (legend-imfe, legend-9fo4, legend-tp3x)
Berkas milik: `apps/web/src/routes/_kelola/reports.*.tsx` (baru), `apps/web/src/features/ws11-reports/nav.ts`, `apps/web/src/features/ws11-reports/mock.ts`, `packages/shared/src/dashboard/reports.ts`, `packages/shared/src/dashboard/values.ts`, `apps/web/src/features/ws11-management-home/lib.ts`, `apps/web/src/features/ws11-owner-dashboard/board.ts`, `apps/web/src/routeTree.gen.ts`, test baru `tests/ws11-report-pages.test.mjs`.
- Batch A: famili menu (engineering dll), payments, tax, inventory, cogs (HPP, termasuk `inventory.food_cost`), purchasing. Batch B: finance, loyalty, crm, reservation, attendance, payroll, performance.
- Resep: kode ada di `packages/shared/src/dashboard/catalog.ts` (jangan ubah catalog). Tambah route tipis seperti `reports.sales.daily.tsx` memanggil `reportRouteOptions("<code>")`, daftarkan di `SERVED_REPORTS` (`mock.ts:226`) dan nav, regen `routeTree.gen.ts` (`cd apps/web && npx tsr generate`; kalau gagal, laporkan).
- Mock angka uang famili finance/payroll/tax/cogs memakai satu model hari yang sama (`buildSalesRuns`/day model) supaya I4 terjaga; jangan buat angka lepas.
- tp3x: `dashboardTilePath()` harus menunjuk route yang ada; link yang sebelumnya disembunyikan karena 404 (commit ac50f12b) tampil lagi bila halamannya kini ada. Pertahankan parameter periode/outlet (DASH-02).
- Bukti: `pnpm test` hijau untuk `tests/ws11-*.test.mjs` dan `tests/dashboard-contract.test.mjs`; `pnpm --filter @starter/web typecheck`.

### F — rekonsiliasi fixtures demo (legend-wr5z, legend-zc3g)
Berkas milik: `packages/shared/src/dashboard/fixtures.ts`, `packages/shared/src/metrics/fixtures.ts`, mock helper owner/shareholder/management di `apps/web/src/features/ws11-owner-dashboard/`, `ws11-shareholder/`, `ws11-management-home/` (KECUALI `ws11-management-home/lib.ts`, `ws11-owner-dashboard/board.ts`, `ws11-shareholder/board.ts`), test baru `tests/ws11-fixture-reconcile.test.mjs`. JANGAN sentuh `ws11-reports/mock.ts` (milik R).
- wr5z: outlet+tanggal 2026-11-01 yang sama, `net_sales` owner (7,42 jt) vs GM home (44,75 jt) harus satu angka. Ganti nama metrik "Table turnover" ke Bahasa Indonesia.
- zc3g: shareholder berjalan 1–5 Nov vs model hari viewer; businessDate shareholder 5 Nov vs 1 Nov di tempat lain; YTD shareholder vs owner Agu/Sep; owner `crm.promo_cost` vs diskon (cek label, metrik beda boleh beda angka tapi label harus jelas). Keputusan: angka akuntansi berjalan = MTD estimasi (bukan proyeksi bulan), berlabel estimasi.
- Test baru menegaskan: metrik sama + outlet sama + periode sama ⇒ nilai sama di semua fixture.
- Ubah sampel jadwal di `fixtures.ts` (~baris 388) mengikuti skema baru potongan S: `recipientUserIds` berisi UUID user tenant, bukan email.
- Bukti: `pnpm test` hijau untuk test baru + test ws11 yang ada; update ekspektasi e2e/unit lama yang memakai angka lama (sebut berkas yang kamu ubah).

### S — keputusan reviewer kontrak dashboard (legend-spks)
Berkas milik: `packages/shared/src/dashboard/builder.ts`, `packages/shared/src/dashboard/exports.ts`, `packages/shared/src/dashboard/catalog.ts` (hanya peta famili→permission ~baris 60–79), `apps/web/src/features/ws11-reports/route-options.tsx`, komponen builder/viewer di `apps/web/src/features/ws11-reports/` (KECUALI `nav.ts`, `mock.ts`), `apps/web/src/features/ws11-shareholder/board.ts`, seluruh `apps/web/src/features/ws11-report-builder/**`, `packages/shared/src/i18n/messages/report-builder.ts`, `tests/ws11-report-builder.test.mjs`, test baru `tests/ws11-dashboard-decisions.test.mjs`. Di `packages/shared/src/dashboard/reports.ts` (milik R) S hanya boleh mengubah blok `PERSONAL_DATA_DIMENSIONS` + `selectionContainsPersonalData`; edit sekecil mungkin, baca ulang berkas sebelum tiap edit karena R juga mengedit berkas itu.
1. Laporan yang ditautkan dari tile shareholder menerima `report.aggregate.view` dan hanya agregat: tanpa PII, tanpa split per karyawan/pelanggan/member.
2. Ekspor terjadwal yang memuat data pribadi tetap ditolak (skema refine).
3. Penerima jadwal: ganti `recipients` (email) menjadi `recipientUserIds: z.array(z.uuid()).min(1).max(20)`, duplikat ditolak; server yang meresolusi email. Form builder di web memilih user, bukan mengetik email.
4. Split identitas = `employee`, `customer`, `member` (satu konstanta diekspor, dipakai builder, ekspor, dan guard shareholder).
- Bukti: `pnpm test` hijau (test baru + `tests/ws11-report-builder.test.mjs`), typecheck shared + web.

### C — kontrak perbandingan + antrean tile (legend-v3pt, legend-kx94)
Berkas milik: `packages/shared/src/dashboard/dashboards.ts`, berkas baru `packages/shared/src/dashboard/tile-values.ts`, `packages/shared/src/dashboard/endpoints.ts`, `packages/shared/src/dashboard/index.ts`, test baru `tests/ws11-tile-values.test.mjs`.
- v3pt: payload nilai tile dashboard berisi nilai + target + perbandingan periode sebelumnya, pakai ulang `metricComparisonSchema` (`packages/shared/src/metrics/schemas.ts:466`). Endpoint `GET /api/dashboards/:dashboardCode/values` (atau setara) dengan query periode/outlet; nilai uang membawa `finality` (I2).
- kx94: payload baris antrean (kitchen_queue, waiter_calls, reviews, facility_units) dan baca scope fasilitas per outlet (daftar `facilityId` untuk outlet) supaya FE bisa memanggil `GET /api/facility/units/:facilityId`.
- Kontrak saja (skema Zod + endpoint object + fixture kecil di `tile-values.ts`). Jangan sentuh FE atau API.
- Bukti: test baru hijau, `pnpm --filter @starter/shared typecheck`.

### D — unduh dokumen shareholder + endpoint audit (legend-135u, legend-zbzr)
Berkas milik: `apps/web/src/features/ws11-shareholder/` (KECUALI `board.ts` dan mock helper milik F; boleh berkas komponen dokumen baru), berkas baru `apps/api/src/routes/audit-events.routes.ts`, `apps/api/src/services/audit-events.service.ts`, `apps/api/src/test/audit-events.test.ts`, `apps/api/src/app.ts` (mount saja).
- 135u: kontrak sudah ada di `@starter/shared/accounting` (`createShareholderDocumentSignedUrl`, route di `apps/api/src/routes/shareholder-documents.routes.ts`). Tile dokumen shareholder menampilkan tombol unduh yang meminta signed URL; shareholder hanya dokumen published miliknya (sudah dijaga server).
- zbzr: kontrak `listAuditEventsEndpoint` sudah di `packages/shared/src/audit/endpoints.ts:63` dan FE sudah mengimpornya. Server belum melayani: buat route `GET /api/audit/events` (cursor page, terbaru dulu) dari tabel `auditLogs` (`apps/api/src/db/schema/core-audit.ts:14`), pakai `withTenant`, permission audit yang ada di `packages/shared/src/access/permissions.ts`, masking dari `packages/shared/src/audit/masking.ts`. Ikuti pola route Express + `requireAuth` di route lain.
- Bukti: `pnpm --filter @starter/api exec vitest run src/test/audit-events.test.ts` (butuh DB: `pnpm db:up`, kalau DB tidak tersedia laporkan), typecheck api + web.

### E — runtime lapisan metrik (legend-cdta), tingkat K
Berkas milik: `apps/api/src/db/schema/dashboard*.ts` (baru), migrasi baru `apps/api/drizzle/0079_*` (lewat `pnpm db:generate` + berkas `*_rls.sql` sesuai pola 0078), `apps/api/src/services/metrics*.ts` (baru), `apps/api/src/routes/metrics*.routes.ts` (baru, ekspor factory router; JANGAN mount di `app.ts`, agent yang mount), `apps/api/src/test/metrics-runtime*.test.ts`, `packages/shared/src/metrics/index.ts` dan berkas baru `packages/shared/src/metrics/endpoints.ts`.
- Satu jalur query untuk dashboard, laporan, AI, MCP: evaluasi registry (`packages/shared/src/dashboard/metric-catalog.ts`, `packages/shared/src/metrics/schemas.ts`), agregasi `metrics_daily`, materialized view bila perlu, outlet scope, `closed_period_only` vs `live`.
- I1 ketat: metrik uang dibaca dari `journalLines` (per akun via `chartOfAccounts`/`accountMappings`, per outlet `journalLines.outletId`), periode tertutup dari `fiscalPeriodSnapshotLines`. Cek dulu definisi "posted" di `accounting.ts` (~baris 228). Jangan baca tabel order/payment untuk angka uang.
- Endpoint `GET /api/metrics/query` dengan `metricQueryResponseSchema` (`packages/shared/src/metrics/schemas.ts:541`).
- Test: parity — total metrik uang == saldo jurnal GL untuk akun/outlet/periode sama; periode tertutup → `final`, berjalan → `estimate`; outlet scope ditegakkan; tenant RLS.
- Bukti: vitest berkas test baru hijau (DB lokal), typecheck api.

### T — test acceptance (test-writer, paralel)
Berkas milik: `apps/api/src/test/ws11-gl-parity.acceptance.test.ts` (baru). Dari PRD DASH-02, SH-01, SH-02 + I1: seed jurnal GL, panggil `GET /api/metrics/query` (kontrak dari E di `packages/shared/src/metrics/endpoints.ts`; kalau belum ada, tulis terhadap `metricQueryResponseSchema` dan tandai bagian yang menunggu nama endpoint). Jangan baca implementasi E.

### F2 — gelombang 2 (legend-3nuv + sisa temuan), setelah R selesai
Berkas milik: `apps/web/src/features/ws11-reports/mock.ts`, `apps/web/src/features/ws11-owner-dashboard/insights-mock.ts`, fixture management di `packages/shared/src/dashboard/fixtures.ts`, `tests/dashboard-contract.test.mjs`, `tests/ws11-fixture-reconcile.test.mjs`.
- 3nuv: run mock owner part2, management, shareholder, dan viewer memakai satu tabel Oktober; kunci run mempertimbangkan outlet; pax shareholder (7920) vs `sales.per_pax` (4515) harus satu angka.
- `purchase_total` hari berjalan Rp38,6 jt di KPI management tidak masuk akal untuk satu hari: ganti di fixture management dan `mock.ts` dengan angka harian yang konsisten dengan model hari.
- Ekspor `MONTH_FIGURES` dari `insights-mock.ts`, hapus duplikat konstanta Oktober di `mock.ts`.
- `tests/dashboard-contract.test.mjs:613-614` masih memakai `recipients`; ubah ke `recipientUserIds`.
- Bukti: `node --test tests/ws11-*.test.mjs tests/dashboard-contract.test.mjs` hijau, typecheck shared + web.

## Laporan tiap potongan
Berkas berubah, perintah test yang dijalankan + hasil, hal yang tidak bisa diverifikasi, keputusan yang kamu ambil. Butuh berkas di luar daftar milikmu: berhenti dan laporkan, jangan edit.
