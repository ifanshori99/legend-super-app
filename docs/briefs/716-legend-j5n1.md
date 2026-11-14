# Brief: engineer (Codex) — Backup memakai POSTGRES_USER (legend-j5n1)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Jangan jalankan `bd` selain `bd show` read-only.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree: `git worktree add -b fix/backup-postgres-user .worktrees/backup-postgres-user origin/milestone/m1`.

## Tujuan
bd show legend-j5n1. deploy/backup/pgbackrest.conf.example tidak punya pg1-user dan deploy/backup/restore-drill.sh:36 menjalankan psql tanpa -U, jadi keduanya jatuh ke login postgres. Jadikan user eksplisit dan bisa diatur (POSTGRES_USER, default sama seperti compose/env.example), dokumentasikan di docs/deployment.md bila ada bagian backup. Test: jalankan restore-drill dalam mode uji/dry-run bila tersedia atau test shell sederhana (bats/sh) yang memeriksa perintah memakai -U. Jangan sentuh rahasia atau env production.

## Bukti, sebelum melapor
Test gagal-dulu lalu hijau lewat `heavy`, pra-gate AGENTS.md pada file yang diubah (prettier, eslint, typecheck api lewat `heavy` bila TypeScript berubah). Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Push `fix/backup-postgres-user` tanpa force. Jangan merge, jangan deploy.
