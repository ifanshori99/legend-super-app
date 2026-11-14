# Brief: engineer (Codex) — DASH-02 merah di ws/reports-dashboard-fixes

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Jangan jalankan `bd` selain `bd show` read-only.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree: `git worktree add .worktrees/reports-dashboard-fixes ws/reports-dashboard-fixes` (bila cabang lokal tidak ada: `-b ws/reports-dashboard-fixes ... origin/ws/reports-dashboard-fixes`).

## Tujuan
Merge train batch62 mengeluarkan cabang ini: test root DASH-02 gagal 17 dari 18 di cabang ini, lulus 18/18 di `milestone/m1`. Kandidat file: `tests/ws11-owner-dashboard.test.mjs`, `tests/ws11-management-home.test.mjs`, `tests/ws11-report-day-model.test.mjs` (Grep `DASH-02`). Reproduksi dengan `LEGEND_TEST_FILES="<file>" heavy pnpm test`, cari apa di diff cabang (`git diff origin/milestone/m1...HEAD`) yang mematahkannya: test usang karena perilaku baru yang benar (perbarui test, jangan longgarkan) atau regresi di kode (perbaiki kode). Lalu merge `origin/milestone/m1` terbaru ke cabang (tanpa rebase/force) dan pastikan DASH-02 serta test terarah file yang diubah cabang hijau.

## Bukti, sebelum melapor
Akar masalah dengan baris kode, test terarah hijau lewat `heavy`, pra-gate AGENTS.md (prettier, eslint, typecheck web dan api lewat `heavy`, sekali). Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Push `ws/reports-dashboard-fixes` tanpa force. Jangan merge ke milestone, jangan deploy.
