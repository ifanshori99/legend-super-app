# Sizing 1246: k0i8, x73li (+qlirp, ay6e6, y3huu), tvkuz, 0orff

Architect, read-only, 21 Nov 2026. Kode dibaca di `legend-m1-read` (milestone/m1 6f418df53).
Konteks rilis 1: Cafe Legend, satu tenant, satu outlet dengan edge, gateway via env.
Penelusuran dihentikan atas permintaan CTO; butir bertanda **[BELUM PASTI]** perlu satu cek lagi sebelum kartu dikerjakan.

## Ringkasan

| Bead | Triase 1240 | Putusan | Alasan singkat |
|---|---|---|---|
| legend-k0i8 | BLOK | **SESUDAH** + 1 kartu S penjaga (masuk gelombang rilis) | Ingest order edge ke cloud sudah ada (legend-771dl) dan sudah membuat jurnal; Tutup Hari outlet edge terjadi di edge. Celah tersisa sempit. |
| legend-x73li | BLOK | **SESUDAH** (sebagian kecil BLOK, lihat bawah) | Web laporan dan dasbor sudah memanggil API asli; `mock.ts` hanya aktif bila `VITE_API_MOCK=true`. Keluarga tanpa sumber tampil "tidak tersedia", bukan angka palsu. |
| legend-qlirp | SESUDAH | SESUDAH | `metric-sources/finance.ts` kosong; 12 metrik uang GL sudah ada di `gl.ts`. |
| legend-ay6e6 | SESUDAH | SESUDAH + 1 kartu S sembunyikan tombol | Endpoint ekspor/jadwal ada di kontrak shared tapi tidak dipasang di API. |
| legend-y3huu | SESUDAH | SESUDAH | `metric-sources/hr.ts` kosong; bergantung legend-07eg. |
| legend-tvkuz | BLOK | **SESUDAH** | Absen HP (`selfie_geo`, `rotating_qr`) dan layar QR cloud (`/kelola/absensi/qr`) sudah ada; backend layar outlet siap. Layar outlet hanya cadangan staf tanpa kuota. |
| legend-0orff | BLOK | **SESUDAH** + 1 kartu S jalur non-SQL | Seed 0211: DOIT nyala dan bawaan, Duitku mati. API Super Admin `PUT /api/platform/payment-gateways/:provider` sudah ada. |

## legend-k0i8 (sinkron order POS offline, penyesuaian terlambat)

Sudah ada:
- `apps/api/src/edge/order-ingest.ts`: `order.paid`/`order.voided` dari edge menjadi baris `orders` cloud dengan `business_date` dari payload (`:469`, `:545`), dan memposting jurnal penjualan lewat `deliverAutoJournalEvent` (`:18`, `:552`). Catatan B1 di `docs/design/edge-order-ingest.md` (jurnal belum ada) sudah usang.
- Jurnal ke bulan fiskal tertutup sudah digeser ke hari buka pertama (`late_adjustment_from`, test F19 di `apps/api/src/test/accounting-auto-journal.test.ts:2187`).
- Route Tutup Hari `/api/outlets/:outletId/pos/day/close` dilayani edge (`EDGE_API_PREFIXES`), jadi rekap beku outlet edge memuat semua order edge (order dibuat di edge sendiri). Klien POS web tidak punya antrean offline sendiri.
- Failover edge ke cloud (`docs/design/edge-cloud-failover.md`) belum dibangun di m1 (tidak ada `outlet_failover_windows`).

Yang kurang:
- Ingest tidak memeriksa `pos_daily_closes` cloud. Bila ada baris tutup hari di cloud untuk (outlet, tanggal) itu, order edge yang datang terlambat masuk diam-diam ke hari yang sudah ditutup (tanpa tanda, audit, atau notifikasi manajer).
- **[BELUM PASTI]** Apakah Tutup Hari bisa juga dijalankan di cloud untuk outlet yang punya edge aktif (tidak ditemukan penjaga). Bila bisa, celah di atas nyata.
- **[BELUM PASTI]** `metric-sources/types.ts:73`: metrik POS "final" butuh baris `pos_daily_closes` di cloud. Bila `day.closed` dari edge tidak membuat baris itu di cloud, metrik POS outlet edge tidak pernah final. Ini masalah tampilan laporan, bukan uang.

Putusan: SESUDAH untuk desain penuh (flag penyesuaian terlambat + pindah ke hari buka berikut), karena untuk rilis 1 hanya terjadi bila hari ditutup di cloud. Penjaga murah masuk rilis:
- **K0-1 (S, Sonnet, tanpa mockup):** tolak `POST .../pos/day/close` di cloud untuk outlet dengan edge primer aktif (409 `DAY_CLOSE_ON_EDGE`), atau, bila CTO memilih deteksi saja: ingest mencatat audit `order.late_for_closed_day` + notifikasi manajer pola `edge-sync-conflict-alert.ts`, tanpa mengubah tanggal. Berkas: `apps/api/src/services/pos-day.service.ts` (atau `apps/api/src/edge/order-ingest.ts`), test baru `apps/api/src/test/edge-order-late-day.test.ts`. Rekomendasi: tolak di cloud (lebih sederhana, tidak ada data ganda).
- **K0-2 (S, Explore dulu):** pastikan butir metrik "final" di atas; bila benar, kartu terpisah untuk mencerminkan `day.closed` edge ke cloud.
- Desain penuh k0i8 (migrasi flag + tanggal asli, applier, rekap): kerjakan bersama failover, sesudah rilis 1.

## legend-x73li (+ qlirp, ay6e6, y3huu)

Sudah ada:
- `apps/web/src/features/ws11-reports/{api,queries}.ts` dan `ws11-owner-dashboard/queries.ts` memanggil endpoint shared (`callEndpoint`). Berkas `mock*.ts` hanya diimpor lewat registri `apps/web/src/lib/mock/` (aktif bila `VITE_API_MOCK=true`). Klaim triase "masih mock.ts" tidak tepat.
- API: `routes/reports.routes.ts` (katalog, definisi, run), `dashboards.routes.ts`, `metrics.routes.ts`. Sumber metrik terisi untuk sales, payments-tax, menu-cogs, inventory-purchasing, traffic-operations, loyalty-crm, reservation-delivery, facility, dan 12 metrik GL.
- Metrik tanpa sumber dijawab `unavailable` (`services/metrics-query.service.ts:1020-1060`, `report-run.service.ts:317`), jadi tidak ada angka palsu.

Yang kurang:
- finance (qlirp, 8 laporan) dan hr (y3huu, 12 laporan) kosong: tampil "tidak tersedia".
- ekspor/jadwal (ay6e6): `packages/shared/src/dashboard/endpoints.ts:160-200` mendefinisikan `/api/reports/exports` dan `/schedules`, tapi tidak ada handler di API. Tombol ekspor di web akan gagal (404).
- **[BELUM PASTI]** Apakah build production menjamin `VITE_API_MOCK` tidak `true` (cek `apps/web` env/doctor). Bila tidak dijaga, ini satu-satunya jalur "angka palsu".
- **[BELUM PASTI]** Tile dasbor owner mana yang mengutip metrik finance/hr (akan tampil "tidak tersedia").

Putusan: x73li SESUDAH sebagai bead payung (e2e + paritas). Masuk rilis hanya dua kartu S:
- **X7-1 (S, Sonnet, tanpa mockup):** penjaga build: `apps/web` production menolak/abaikan `VITE_API_MOCK=true` (cek di `apps/web/src/lib/api/mock-flag.ts` + `scripts/doctor` atau vite config), test di `apps/web` atau `tests/`.
- **X7-2 (S, ui-engineer Sonnet, tanpa mockup baru):** sembunyikan tombol ekspor/jadwal dan sembunyikan laporan keluarga finance/hr dari katalog selama sumbernya kosong (atau tampilkan status "segera" yang sudah ada). Berkas: `apps/web/src/features/ws11-reports/components/*`, `nav.ts`; teks baru ke katalog text-contract.
- qlirp (M, Opus, K): sumber finance di `metric-sources/finance.ts` + `test/ms-finance.test.ts`; tunggu hasil 1247 (c) untuk legend-905j.
- y3huu (M, Sonnet, K): `metric-sources/hr.ts` + `test/ms-hr.test.ts`; tunggu legend-07eg (1247 b).
- ay6e6 (M, Opus, K, migrasi 3 tabel): bergantung legend-hyq (kanal notifikasi) untuk jadwal; ekspor saja bisa dipisah lebih dulu.

## legend-tvkuz (layar absen outlet di edge)

Sudah ada: backend `POST /api/hris/attendance/outlet-clock` dan `GET /api/hris/attendance/qr` di `EDGE_API_EXACT_ROUTES` (`apps/api/src/edge/mode.ts:118-137`); metode `outlet_device` di `packages/shared/src/hris/attendance.ts:44`; absen HP `apps/web/src/routes/_karyawan/karyawan.absensi.index.tsx`; layar QR cloud `apps/web/src/routes/_kelola/kelola.absensi.qr.tsx`; koreksi manual `manual_correction`.

Yang kurang: UI layar outlet di edge (pilih nama, PIN, selfie, pesan galat 401/409/429/403/400), belum ada mockup.

Putusan: SESUDAH. Payroll tetap dapat data hadir dari absen HP; staf tanpa kuota memakai koreksi manual supervisor sampai layar outlet ada. **[BELUM PASTI]** Layar QR cloud dibuka di perangkat outlet butuh internet; saat internet outlet putus, absen `rotating_qr` tidak jalan (HP `selfie_geo` tetap jalan lewat data seluler).
- **TV-1 (designer Codex):** mockup layar absen outlet, gerbang review founder.
- **TV-2 (M, ui-engineer Opus):** bangun di prefiks web edge (`EDGE_WEB_PREFIXES`, mis. `/operasional/absen`), ui-auditor. Sesudah TV-1.

## legend-0orff (panel Super Admin gateway)

Sudah ada: tabel global `platform_payment_gateways` (migrasi `0211`, seed DOIT nyala+bawaan, Duitku mati), reader dengan cache 30 dtk dan writer Super Admin (`apps/api/src/services/platform-payment-gateway.service.ts`), route `apps/api/src/routes/platform-payment-gateways.routes.ts` (`requirePlatformAuth` + `requirePlatformAdmin`), pemilihan gateway per aturan routing + fallback (`payment-gateway-select.ts`).

Yang kurang: UI panel. Tanpa panel, mengubah nyala/mati, bawaan, jendela webhook, atau tenggang secret harus lewat panggilan API Super Admin.

Putusan: SESUDAH, dengan syarat. Rilis 1 cukup bila gateway yang dipakai Cafe Legend sudah benar di seed. **[BELUM PASTI]** Gateway rilis 1: bila DOIT, tidak perlu apa-apa; bila Duitku (brief 395), Duitku harus dinyalakan.
- **0O-1 (S, Sonnet, tanpa mockup):** skrip CLI Super Admin `pnpm --filter @starter/api gateway:set <provider> --enabled --default` yang memanggil service writer yang sama (audit `platform_payment_gateway_changes` tetap tertulis), meniru `src/set-role.ts`. Test `apps/api/src/test/platform-gateway-cli.test.ts`. Ini menggantikan "harus SQL".
- **0O-2 (designer Codex lalu ui-engineer Sonnet):** mockup panel di area platform, review founder, lalu build. Sesudah rilis 1.

## Urutan saran untuk gelombang rilis

1. Paralel, semua S tanpa mockup: K0-1, X7-1, X7-2, 0O-1, plus Explore K0-2.
2. Sesudah 1247: qlirp, y3huu (bergantung 905j dan 07eg).
3. Sesudah rilis 1: ay6e6, desain penuh k0i8 (bersama failover), TV-1/TV-2, 0O-2, payung x73li.

## Butuh founder

- Gateway rilis 1: DOIT atau Duitku (menentukan perlu 0O-1 sebelum rilis).
- Setuju absen outlet tanpa kuota memakai koreksi supervisor di rilis 1 (layar outlet menyusul).
