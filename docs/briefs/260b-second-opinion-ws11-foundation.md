# Brief: second-opinion (Codex) — WS-11 fondasi laporan dan metrik (kartu A, legend-5wzoc)

Jangan dijalankan sebelum CTO memutuskan. Tingkat K (uang, migrasi, akses data). Effort: xhigh (migrasi).

## Peran
Baca `~/.agents/team/roles/second-opinion.md`, lalu ikuti. Hanya membaca dan melapor; jangan mengedit.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, cabang `ws/ws11-foundation` (dibandingkan dengan `milestone/m1`). Worktree `.worktrees/ws11-foundation`.

## Konteks
- Keputusan: `docs/DECISIONS.md` entri 2026-11-10 "Metric sources, metrics_daily and report runs".
- Bentuk konkret: `docs/briefs/sub-ws11-foundation-design.md`.
- Pecahan kartu: `docs/briefs/259-ws11-card-split.md`.

## Yang diperiksa
1. Isolasi tenant dan outlet: `metrics_daily` (migrasi `0176_metrics_daily.sql`, `db/schema/metrics.custom.sql`), job `worker/metrics-daily.job.ts` + `services/metrics-daily.service.ts`, report run `routes/reports.routes.ts` + `services/report-run.service.ts`. Apakah pembaca outlet-scoped atau viewer agregat bisa melihat angka di luar jangkauannya (lewat groupBy, filter, preview, residual `__ledger_adjustment__`)?
2. Angka uang: 12 metrik GL harus identik dengan m1; residual split = total GL − jumlah baris; tidak ada angka palsu (laporan tanpa sumber menjawab `availability: unavailable`, nilai null).
3. Finality: `final` hanya bila hari settled (+ `pos_daily_closes` bila perlu) dan buku tertutup untuk metrik `closed_period_only`; bulan yang dibuka ulang kembali ke `estimate`.
4. Idempotensi job: advisory lock, upsert hanya bila berubah, hapus dimensi yang hilang, savepoint per keluarga.
5. Migrasi: FK di dalam CREATE TABLE, FORCE RLS tenant + outlet, `when` 1794255000000, prevId = snapshot 0166.
6. Kontrak shared: `availability` wajib di `reportResultSchema` dan `metricQueryResponseSchema`; dampak ke web mock dan konsumen.

## Laporan
Temuan dengan path:line, tingkat (blokir/penting/saran), dan skenario gagal konkret. Tidak ada temuan: katakan begitu.
