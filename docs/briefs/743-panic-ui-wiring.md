# Brief: ui-engineer (Claude Opus) — wiring UI alert panik + pasang di shell fasilitas (legend-jztb7)

## Peran
Baca `~/.agents/team/roles/ui-engineer.md`, `~/.agents/team/ui-standard.md`, dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md`, lalu ikuti. `bd show legend-jztb7`.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree: `git worktree add -b ui/panic-alert-wiring .worktrees/panic-alert-wiring origin/ui/panic-alert`, lalu `git merge --no-ff origin/ws/panic-contract-gaps`. UI Arah A sudah disetujui founder (Q26); jangan ubah desain.

## Tujuan
1. Konsumsi frame `acknowledged` (alert hilang/berubah jadi "Sudah ditangani <nama>" di HP lain), field 409 `acknowledgedBy`/`acknowledgedAt` (tampilkan nama rekan), label `unitCode`/`areaName` (ganti pemetaan useUnitBoard bila tersedia), dan `GET /api/emergency/open-alerts` untuk memulihkan antrean setelah muat ulang/menyambung ulang.
2. Keputusan CTO: layar alert dipasang di tingkat shell fasilitas sehingga alert muncul di halaman fasilitas mana pun (overlay yang sama), bukan hanya `/fasilitas/darurat`. Satu koneksi WebSocket per sesi; tidak dobel saat pindah halaman.
3. Cek tab "Darurat" yang terpotong pada 390 di strip tab shell fasilitas; perbaiki bila memang bug.
Ini fitur keselamatan: alert tidak boleh hilang saat pindah halaman atau muat ulang.

## Bukti, sebelum melapor
Test komponen/antrean gagal-dulu lalu hijau, spec mock (browser lewat `heavy`): alert muncul di halaman fasilitas lain, ditangani rekan, pulih setelah muat ulang. Screenshot 390 dan 1280, `ui-auditor`, pra-gate AGENTS.md (prettier, eslint, teks, typecheck web lewat `heavy`). Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan" (angka subagent). Jangan ubah `docs/PROGRESS.md`. Push cabang tanpa force. Jangan merge, jangan deploy.
