# Brief: engineer (Codex) — kartu S: flake test, isolasi test, CI

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Jangan jalankan `bd` (CTO memindah kartu).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree sendiri: `git worktree add -b ws/s-tier-flakes-ci .worktrees/s-tier-flakes-ci milestone/m1`.

## Kartu (baca dengan `bd show <id>` read-only boleh)
1. legend-0jx9: test TEN-01 inventori gagal bila tenant punya >100 item.
2. legend-dyws: flaky `kds-realtime.test.ts` (SLA push 2 dtk, batas 20 layar) saat beban paralel.
3. legend-jnsg1: test edge-catalog-sync dan catalog-puller berbagi DB, menghalangi paralel.
4. legend-ffq8m: tetap fileParallelism serial saat `heavy` membatasi Vitest (urut setelah jnsg1; sama-sama config vitest).
5. legend-fraa: CI menjalankan test skrip deploy/backup/monitoring (`test-scripts.sh`, `test-deploy.sh`, `check.test.mjs`).
6. legend-tbl4: dedupe alarm edge: index `notification_outbox` + test tanpa supervisor. Hanya index, tanpa ubah data. Migrasi: nomor `0573` saja; `node ~/.agents/team/check-journal.mjs origin/milestone/m1` wajib.

Cabang `ws/suite-flakes` (antre merge) mungkin sudah menyentuh flake serupa: cek `git diff milestone/m1...origin/ws/suite-flakes --stat` dulu, jangan duplikasi; bila kartu sudah tertutup di sana, laporkan saja.

## Pembagian paralel
Subagent Codex bawaan (maks 6): satu per kartu 1, 2, 5, 6; kartu 3+4 satu subagent berurutan. Satu subagent saja yang menjalankan test lewat `heavy` (`LEGEND_TEST_FILES=... heavy pnpm test`).

## Bukti selesai
Test flake dijalankan ulang minimal 3 kali hijau lewat `heavy`. Test gagal-dulu (0jx9, tbl4) merah di base. Pra-gate AGENTS.md (prettier, eslint, typecheck api lewat `heavy`).

## Sebelum melapor
Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Push `ws/s-tier-flakes-ci` tanpa force. Jangan merge, jangan deploy.
