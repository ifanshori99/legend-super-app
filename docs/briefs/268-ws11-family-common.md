# Brief umum: engineer (Sonnet) — WS-11 kartu keluarga laporan

Dipakai oleh brief 268a, 268b, 268c. Satu thread memegang beberapa keluarga sekaligus: satu `implementer` per keluarga, paralel, karena berkas keluarga tidak bertumpuk.

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Bacaan wajib
- `docs/briefs/259-ws11-card-split.md`: tabel keluarga dan berkas standar.
- `docs/DECISIONS.md` entri 2026-11-10 (WS-11): total uang dari GL; pecahan dari data pesanan lewat `metrics_daily` dengan baris residual `__ledger_adjustment__`; `availability` untuk yang belum tersedia; aturan `final`/`estimate`; backfill `recomputeMetricsDaily` wajib sebelum reader keluarga dirilis.
- `apps/api/src/services/metric-sources/types.ts` dan `index.ts` di basis.

## Repo
Basis `ws/ws11-foundation` (eb4383cb, antre merge train). Satu cabang per keluarga: `ws/ws11-<keluarga>` dengan worktree `.worktrees/ws11-<keluarga>` dan `worktree:setup` di tiap worktree. Jangan checkout di folder utama. Jangan push, jangan merge.

## Berkas
Tiap keluarga X hanya mengubah:
- `apps/api/src/services/metric-sources/X.ts`
- `apps/api/src/test/ms-X.test.ts`
- `apps/web/src/features/ws11-reports/mock-families/X.ts`
- route baru `apps/web/src/routes/_kelola/reports.X.*.tsx` yang memakai viewer generik yang sudah ada. Tidak ada desain baru: layar baru atau komponen baru jadi kartu UI terpisah.

Jangan ubah `metrics-query.service.ts`, `packages/shared/src/dashboard/*`, `packages/shared/src/metrics/*`, `reports.routes.ts`, atau `mock-day-model.ts`. Itu milik thread `ws11-shared` (G88uh). Butuh perubahan di sana: tulis permintaannya di laporan, dan kerjakan sisanya dengan `availability: unavailable` untuk butir yang terhambat.

## Kartu
Awal tiap kartu: `ghostex board associate <id>`, `bd update <id> --status in_progress`. Selesai: `--status review` + `bd comment` bahasa biasa. Kartu masih bergantung pada legend-5wzoc di bd (status review): itu memang disengaja, kerjakan dari basis di atas.

## Bukti selesai (per keluarga)
- Test gagal-dulu: tiap laporan keluarga menjawab angka dari data uji; isolasi tenant dan outlet; jumlah pecahan uang sama dengan total GL (residual terlihat); hari tanpa data tidak `final`; backfill idempoten.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/ms-X.test.ts ..." pnpm test'`, sebut jumlah file dan tes. Regresi 12 metrik GL tetap lulus.
- Typecheck api + web lewat `heavy` sekali di akhir per worktree (berurutan, bukan paralel); eslint + prettier berkas berubah. Jangan `pnpm check` penuh.
- Review (Q48): keluarga uang (tingkat K) satu `architect` untuk diff gabungan semua keluarga thread ini; keluarga S satu `reviewer`.
- Tulis brief Codex `docs/briefs/<nomor>b-second-opinion-ws11-<grup>.md` untuk keluarga K, jangan dijalankan.

## Laporan
Sekali di akhir: per keluarga (cabang, SHA, laporan yang kini berangka, yang masih unavailable dan alasannya), migrasi bila ada, permintaan berkas bersama, kartu baru, bukti, risiko, jumlah subagent dan puncak bersamaan.
