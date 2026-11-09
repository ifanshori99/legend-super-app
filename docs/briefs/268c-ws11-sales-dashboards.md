# Brief: WS-11 keluarga F1 dan F11

Ikuti `docs/briefs/268-ws11-family-common.md` sepenuhnya.

| Kartu | Keluarga | Laporan | Tingkat | Migrasi |
|---|---|---|---|---|
| legend-ne81z (F1) | `sales` | `sales.*` (13), metrik net_sales sampai menu_sold_qty, target penjualan; `sales.per_channel/per_menu/per_hour/per_employee` dari pesanan dengan GL sebagai kontrol; pindahkan `ai-metrics/sales.ts` ke registry | K | ya: tabel `sales_targets`, `0181` `when` 1794260000000, RLS tenant/outlet dipaksa |
| legend-flb8f (F11) | dasbor | API dasbor owner, pemegang saham, manajemen + queues, endpoint batch (target p95 <= 3 detik untuk 18 run per muat lewat `metrics_daily`), serap legend-1ye3 dan legend-5bjh | K | tidak |

F1: API target penjualan saja. Layar target butuh mockup, jadi buat kartu designer + UI dan sebut kontraknya. Route laporan sales lain memakai viewer generik.

F11: endpoint dasbor dan batch tinggal di berkas baru `apps/api/src/routes/dashboards.routes.ts` + `services/dashboard-run.service.ts` (berkas milik F11). Kontrak endpoint dasbor ada di `packages/shared/src/dashboard/endpoints.ts`. Bila kontrak perlu berubah, tulis permintaannya di laporan (milik G88uh).

Dua implementer paralel. Uji `pnpm db:generate` lalu periksa SQL; generate kedua kosong; test migrasi RLS (`migration-force-rls-guard`, `migration-fk-force-rls`). Review: satu `architect` untuk diff gabungan. Brief Codex: `docs/briefs/268cb-second-opinion-ws11-sales-dashboards.md` (xhigh: migrasi).
