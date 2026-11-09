# Konteks bersama implementer WS-11 F5, F8, F10

Baca dulu: `docs/briefs/268-ws11-family-common.md` (aturan berkas, bukti selesai), `docs/DECISIONS.md` entri 2026-11-10 butir 1-8, `docs/briefs/sub-ws11-foundation-design.md` §2.1, §2.4, §2.5, dan `apps/api/src/services/metric-sources/types.ts` + `index.ts`.

## Aturan reader (ringkas)
- Satu `MetricSource` per kode metrik (`daily`, `derived`, atau `unavailable`); kode tak diklaim = `source_not_built`.
- Reader `daily`: `metricCodes`, `dimensions`, `requiresDailyClose`, `compute({tx, tenantId, outletId, businessDate})`. Wajib mengembalikan baris total (dimension null) untuk SETIAP kode yang didaftarkan, nol bila tidak ada aktivitas. Tanpa baris total, bucket tetap `estimate`.
- Pecahan non-outlet hanya satu dimensi per baris; nilai dimensi maks 200 karakter, id saja, bukan nama orang.
- Metrik uang yang diposting buku besar (12 kode GL di `metrics-gl-sources.ts`) tetap dari GL; pecahannya lewat `splits` + baris residual `__ledger_adjustment__`. Metrik uang yang tidak pernah diposting GL boleh baca baris operasional langsung: tulis alasannya di komentar sumber, dan keluarkan dari `NON_GL_MONEY_METRICS` (itu berkas bersama: minta lewat laporan, jangan ubah).
- Rasio (`aggregation: ratio`) = `derived` dari dua kode terdaftar, tidak disimpan.
- Hari tanpa data tidak `final`; backfill `recomputeMetricsDaily(context, outletId, from, to)` idempoten, wajib diuji.
- Berkas milik thread lain (jangan ubah): `metrics-query.service.ts`, `metrics-gl-sources.ts`, `metric-sources/index.ts`, `types.ts`, `gl.ts`, `report-run.service.ts`, `routes/reports.routes.ts`, `db/schema/metrics.ts`, `worker/metrics-daily.job.ts`, `packages/shared/src/metrics/*`, `packages/shared/src/dashboard/*`, `mock-day-model.ts`. Butuh ubah: tulis di `docs/briefs/268b-requests-<keluarga>.md` (satu berkas per keluarga), kerjakan butir terhambat sebagai `unavailable`.

## Berkas milik tiap keluarga X
`apps/api/src/services/metric-sources/X.ts`, `apps/api/src/test/ms-X.test.ts`, `apps/web/src/features/ws11-reports/mock-families/X.ts`, `apps/web/src/routes/_kelola/reports.X.*.tsx` (viewer generik yang ada). Keluarga F5 juga boleh mengubah `apps/api/src/services/ai-metrics/` stok dan `metric-single-path.test.ts` (daftar pengecualian) hanya sejauh memindahkan helper stok ke registry; F10 boleh mengubah `apps/web/src/features/facility-report`.

## Test (gagal dulu)
Tiap laporan menjawab angka dari data uji; isolasi tenant dan outlet; jumlah pecahan uang = total GL (residual terlihat); hari tanpa data bukan `final`; backfill idempoten. Jalankan: `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/ms-X.test.ts" pnpm test'`. Jangan `pnpm check` penuh. Jangan commit (agent induk yang commit). Jangan jalankan typecheck (agent induk menjalankan lewat `heavy`, berurutan). eslint + prettier berkas berubah boleh.

## Laporan implementer (singkat)
Metrik berangka vs `unavailable` + alasan, berkas berubah, hasil test (jumlah file/tes), permintaan berkas bersama.
