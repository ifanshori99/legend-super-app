# 553 Paket B: operasi harian dan replay offline (5 kartu)
Peran: engineer (~/.agents/team/roles/engineer.md). Kartu: legend-ga0n, legend-do1o, legend-7j4e, legend-wf37, legend-8erc. Baca `bd show` tiap kartu dan paket B di docs/briefs/552-triage-result.md (status, sisa, batas file).
Basis: bila ws/checklist-engine belum masuk origin/milestone/m1, buat cabang dari origin/ws/checklist-engine; kalau sudah, dari origin/milestone/m1. `git worktree add .worktrees/ops-daily -b ws/ops-daily <basis>`. Migrasi 0386-0388, `when` di atas migrasi terakhir basis.
Tingkat K (sinkron offline, foto/tanda tangan): replay offline idempoten dan terbatas outlet; upload lewat kontrak storage generik yang ada, jangan ubah core storage (`core-storage.routes.ts`, `core-storage-access.ts` milik paket C).
Jangan sentuh payroll, pajak/akuntansi, CRM, inventory/purchasing, edge, HRIS, UI 539.
Paralel: Explore, test-writer, 1 implementer per kartu (file sama: berurutan), reviewer akhir. Test gagal-dulu, test terarah lewat `heavy`, tsc api/shared/web bila disentuh, eslint/prettier, `db:generate` kosong. Commit per kartu, jangan merge. Lapor dengan angka subagent dan yang belum diuji.
