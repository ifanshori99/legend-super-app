# Sub-brief: WS-11 shared putaran 2, butir 2 (brief 272)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/ws11-shared-2` (cabang `ws/ws11-shared-2`). Konteks: `docs/briefs/272-ws11-shared-serial-2.md`, peta `docs/briefs/maps/272-map-iwsrp.md` dan `docs/briefs/maps/272-map-split-f11-mock.md`, `docs/DECISIONS.md` entri 2026-11-10.

Aturan: hanya berkas slice-mu (lima slice jalan paralel). Butuh berkas slice lain: berhenti dan lapor. Jangan commit. Tanpa migrasi. Test gagal-dulu tiap sub-butir: sebut jumlah merah sebelum fix, lalu hijau. Test API: `bash -c 'cd "<worktree>" && pwd && LEGEND_TEST_FILES="src/test/<f>.test.ts ..." pnpm test 2>&1 | grep -E "Test Files|Tests  |FAIL|×"'`. Test root: `node --test tests/<f>.test.mjs`. Jangan typecheck penuh. Akhiri `pnpm exec prettier --write` + `pnpm exec eslint` berkasmu. Laporan: berkas, merah/hijau per sub-butir, dampak kontrak, sisa. Maks 40 tool call.

## S1 registry dan job harian (legend-iwsrp 1-2)
Berkas: `apps/api/src/services/metric-sources/index.ts`, `apps/api/src/services/metrics-daily.service.ts`, `apps/api/src/test/metric-sources-registry.test.ts`, `apps/api/src/test/metrics-daily-job.test.ts`.
1. `assertRegistry` menolak dua pembaca `metrics_daily` yang menulis kode metrik yang sama (pesan menyebut kode dan kedua pembaca).
2. Hapus baris lama di job hanya dalam dimensi yang ditulis pembaca itu, sehingga pembaca lain dengan kode sama tetapi dimensi lain tidak terhapus.

## S2 engine (legend-iwsrp 3, 4, 10)
Berkas: `apps/api/src/services/metrics-query.service.ts`, `apps/api/src/services/metric-sources/types.ts`, `apps/api/src/services/metric-sources/menu-cogs.ts`, `apps/api/src/test/metrics-runtime.test.ts`, `apps/api/src/test/ms-menu-cogs.test.ts`.
3. Cakupan `final` pecahan GL: baris total final dihitung per outlet (irisan per outlet), bukan gabungan tanggal semua outlet.
4. Rata-rata multi-hari `avg_serving_time`, `avg_dwell_minutes` tertimbang volume (jumlah pembilang / jumlah volume per hari, bukan rata-rata nilai harian).
10. Jenis sumber "porsi dari total" untuk `menu_popularity_pct` (porsi tiap pecahan = nilai pecahan / total periode, dihitung dari jumlah, bukan rata-rata persen harian).

## S3 sumber GL dan persen (legend-iwsrp 7, 8, 9)
Berkas: `apps/api/src/services/metrics-gl-sources.ts`, `apps/api/src/services/metric-sources/payments-tax.ts`, `apps/api/src/test/ms-payments-tax.test.ts`, test GL terkait bila perlu (bukan `metrics-runtime.test.ts`, bukan `ms-menu-cogs.test.ts`; test `food_cost_pct` di berkas test baru `apps/api/src/test/ms-food-cost-pct.test.ts`).
7. Hapus `menu_gross_margin` dari `NON_GL_MONEY_METRICS`.
8. Sumber GL untuk `tax_collected`, `service_charge_collected`, `tax_payable`.
9. Pecahan persen `food_cost_pct` (pembilang dan penyebut dipecah lalu dibagi; bukan rata-rata persen). Butuh `metric-sources/index.ts` atau engine: lapor, jangan edit.

## S4 pecahan net_sales (kartu legend-obwwi)
Berkas: `apps/api/src/services/metric-sources/sales.ts`, `apps/api/src/test/ms-sales.test.ts`.
`net_sales` dipecah per `payment_method` dan `menu_category` (laporan `payments.methods`, `menu.category_sales`), memakai `allocateByWeight` (diekspor dari `payments-tax.ts`, jangan ubah berkas itu). Sales satu-satunya pemilik kode `net_sales`. Jumlah pecahan = total GL (residual `__ledger_adjustment__` bila perlu, seperti pola pecahan lain).

## S5 F11 dasbor (kartu legend-ip4v6)
Berkas: `packages/shared/src/dashboard/dashboards.ts`, `packages/shared/src/dashboard/tile-values.ts`, `apps/api/src/routes/dashboards.routes.ts`, `apps/api/src/services/dashboard-run.service.ts`, `apps/api/src/test/dashboards-api.test.ts`, test root dasbor terkait, fixtures/mock dasbor web yang membangun objek tile bila skema berubah.
1. `managerRole` di query dasbor management (`dashboardQuerySchema`), diteruskan ke `dashboardTilesFor`. Nilai tak dikenal: 400.
2. `availability` + alasan per tile dan per antrean (`source_not_built`/`dimension_not_supported`, pesan Indonesia dari `METRIC_UNAVAILABLE_MESSAGES`).
3. `outletIds` tunggal di GET diterima sebagai array: pastikan dengan test (kode mungkin sudah ada).

## S6 mock (kartu legend-nko71 + legend-iwsrp 6)
Berkas: `apps/web/src/features/ws11-report-builder/mock-preview.ts`, `apps/web/src/features/ws11-reports/mock-day-model.ts`, `apps/web/src/features/ws11-reports/mock-families/sales.ts`, `apps/web/src/features/ws11-reports/mock.ts`, test root `tests/ws11-report-*.test.mjs`, `tests/ws11-reports.test.mjs`.
1. Sel `sales_target` di `mock-preview.ts`.
2. Pecahan `day_of_week` di `mock-day-model.ts` (pindahkan dari hitungan lokal `mock-preview.ts`).
3. Tiga laporan sales baru masuk `SALES_REPORTS`.
4. `SERVED_REPORTS` di `mock.ts` memuat laporan traffic dan operations.
