# WS-11: pecahan kartu laporan dan dasbor (legend-31fi, founder Q54)

Founder Q54: semua laporan standar + angka dasbor dibangun sebelum rilis. Katalog di m1 d8ea5e0b kini 110 laporan dan 89 metrik (16 di `packages/shared/src/metrics/fixtures.ts` + 73 di `metric-catalog.ts`); semuanya masuk lingkup.

Kondisi m1: hanya `GET /api/metrics/query` (12 metrik uang dari GL, pecahan per outlet saja). 25 metrik uang non-GL dan semua metrik non-uang menjawab null (`metrics_daily` belum ada). `/api/reports*` dan `/api/dashboards*` baru kontrak (17 endpoint di `shared/dashboard/endpoints.ts`). Web: viewer generik `features/ws11-reports` + 89 route, semua mock; 21 laporan tanpa halaman.

Berkas standar kartu keluarga X (tidak bertumpuk): `apps/api/src/services/metric-sources/X.ts`, `apps/api/src/test/ms-X.test.ts`, `apps/web/src/features/ws11-reports/mock-families/X.ts`, route baru `apps/web/src/routes/_kelola/reports.X.*.tsx`.

| Kode | Judul kartu | Laporan | Dependensi keras | Migrasi | Tingkat | UI |
|---|---|---|---|---|---|---|
| A | WS-11 fondasi: registry sumber metrik, metrics_daily, report run API | catalog/get/run/preview | — | ya (`metrics_daily`) | K | API |
| F1 | WS-11 laporan Penjualan | `sales.*` (13), metrik net_sales..menu_sold_qty, target penjualan | A | ya (`sales_targets`) | K | mockup layar target + 3 route |
| F2 | WS-11 laporan Trafik dan Operasional | `traffic.*` (5) + `operations.*` (9) | A | tidak | S | 14 route generik |
| F3 | WS-11 laporan Menu dan HPP | `menu.*` (7) + `cogs.*` (4) | A | tidak | K | API |
| F4 | WS-11 laporan Pembayaran dan Pajak | `payments.*` (6) + `tax.*` (4) | A | tidak | K | API |
| F5 | WS-11 laporan Stok dan Pembelian | `inventory.*` (7) + `purchasing.*` (5) | A | tidak | K | API |
| F6 | WS-11 laporan Keuangan | `finance.*` (8), dimensi legal_entity | A, legend-brq1, legend-905j | tidak | K | API |
| F7 | WS-11 laporan Loyalti dan CRM | `loyalty.*` (5) + `crm.*` (6) | A, legend-111j, legend-3zd1, legend-ts50 | tidak | K | API |
| F8 | WS-11 laporan Reservasi dan Delivery | `reservation.*` (4) + `delivery.*` (4) | A | tidak | K | 4 route generik |
| F9 | WS-11 laporan SDM: absensi, payroll, kinerja | `attendance.*` + `payroll.*` + `performance.*` (12) | A, legend-wh71, legend-07eg | tidak | K | API |
| F10 | WS-11 laporan Fasilitas | `facility.*` (11), 19 metrik fasilitas | A | tidak | K | API |
| F11 | WS-11 API dasbor owner, pemegang saham, manajemen | dasbor + queues (gantikan legend-1ye3, legend-5bjh) | A | tidak | K | API |
| F12 | WS-11 ekspor dan jadwal laporan | saved, schedules, exports (gantikan legend-mqds, jadwal legend-atcu, legend-rmvu) | A, legend-hyq | ya (3 tabel) | K | API |
| INT | WS-11 sambung FE laporan dan dasbor ke API asli | e2e + paritas dasbor = laporan (gantikan legend-vr6l, legend-yf2b) | A, F1-F12 | tidak | K | — |

Kartu lama yang diserap: legend-cdta, legend-24nl, legend-atcu (inti) ke A; legend-u21j ke F2; legend-1ye3, legend-5bjh ke F11; legend-mqds, legend-rmvu ke F12; legend-vr6l, legend-yf2b ke INT.

Risiko yang diputuskan di kartu A (architect subagent, dicatat di `docs/DECISIONS.md`):
1. Metrik uang dari GL hanya bisa dipecah per outlet; sekitar 20 laporan (`sales.per_channel/per_menu/per_hour/per_employee`, `cogs.per_menu`, `payments.methods`, `performance.employee`) butuh pecahan dari data pesanan dengan total GL sebagai kontrol.
2. Satu sumber kebenaran: dasbor, laporan, dan AI (`api/services/ai-metrics/sales.ts`, `web/features/facility-report`) memakai registry yang sama.
3. Dasbor owner 18 run per muat: target p95 <= 3 detik lewat `metrics_daily` + endpoint batch (F11).
4. Berkas rawan bentrok (`metrics-query.service.ts`, `shared/dashboard/*.ts`, `mock-day-model.ts`) hanya diubah pemilik A; F1-F12 memakai berkas keluarganya sendiri.
