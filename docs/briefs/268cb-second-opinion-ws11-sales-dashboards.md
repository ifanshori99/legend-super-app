# Brief: second-opinion (Codex) — WS-11 sales (F1) dan dasbor (F11)

Jangan dijalankan sebelum CTO memutuskan. Tingkat K (uang, migrasi, akses data). Effort: xhigh (migrasi).

## Peran
Baca `~/.agents/team/roles/second-opinion.md`, lalu ikuti. Hanya membaca dan melapor; jangan mengedit.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Basis `ws/ws11-shared-1` (a597254c). Cabang `ws/ws11-sales` (F1, legend-ne81z, worktree `.worktrees/ws11-sales`) dan `ws/ws11-dashboards` (F11, legend-flb8f, worktree `.worktrees/ws11-dashboards`). Diff: `git diff a597254c..<cabang>`.

## Konteks
- `docs/briefs/268-ws11-family-common.md`, `docs/briefs/268c-ws11-sales-dashboards.md`, `docs/briefs/259-ws11-card-split.md`.
- Keputusan: `docs/DECISIONS.md` entri 2026-11-10 (WS-11).

## Yang diperiksa
1. Migrasi `0181_sales_targets` (when 1794260000000): FK di dalam CREATE TABLE, FORCE RLS tenant + outlet, journal idx 181, prevId snapshot = id 0176 (4b509979-1366-434b-b94a-e2a00520bd72); rantai ulang bila 0177-0180 masuk lebih dulu; unique (tenant_id, outlet_id, target_date), CHECK target_idr >= 0.
2. API target `/api/outlets/:outletId/sales-targets` (GET, PUT, PUT /month, DELETE): izin (`report.sales.view` baca, `org.settings.manage` tulis), pembatasan outlet, pembagian bulanan habis tanpa sisa, input salah 422.
3. Sumber metrik `metric-sources/sales.ts`: pecahan `per_channel/per_menu/per_hour/per_employee` dari pesanan `status='completed'` memakai `business_date`; jumlah pecahan + residual `__ledger_adjustment__` = total GL; hari tanpa data tidak `final`; backfill `recomputeMetricsDaily` idempoten; viewer agregat tidak bisa memecah per orang.
4. Dua test lama diubah (`metrics-engine.test.ts`, `metrics-runtime.test.ts`): apakah jaminan keamanan melemah.
5. Dasbor `routes/dashboards.routes.ts` + `services/dashboard-run.service.ts`: cache 15 detik berkunci tenant + peran + jangkauan (bocor lintas tenant atau peran?), pemegang saham hanya agregat (`report.aggregate.view`), tile disaring izin, batch sama dengan run satu-satu, bentuk jawaban `availability`.
6. `ai-metrics/sales.ts` dipakai bersama registry: angka tl-01/tl-02/tl-04 tidak berubah.

## Laporan
Temuan dengan path:line, tingkat (blokir/penting/saran), dan skenario gagal konkret. Tidak ada temuan: katakan begitu.
