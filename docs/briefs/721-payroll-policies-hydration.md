# Brief: engineer (Codex) — hydration error PoliciesTab payroll (legend-1iyup)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Jangan jalankan `bd` selain `bd show` read-only.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree sendiri: `git worktree add -b fix/payroll-policies-hydration .worktrees/payroll-policies-hydration origin/milestone/m1`.

## Tujuan
`/kelola/payroll/pengaturan`, komponen PoliciesTab (ws10-payroll-config) merender Skeleton `<div>` di dalam `<p>`, memicu hydration error (terlihat di spec mock payout). Reproduksi dulu (test web atau spec mock yang menangkap error konsol), lalu perbaiki markup tanpa mengubah teks UI atau perilaku. Tanpa migrasi, tanpa sentuh API.

## Bukti, sebelum melapor
Test gagal-dulu, test web terkait hijau lewat `heavy`, pra-gate AGENTS.md (prettier, eslint, typecheck web lewat `heavy`). Browser headless lewat `heavy` (satu sekaligus). Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Push `fix/payroll-policies-hydration` tanpa force. Jangan merge, jangan deploy.
