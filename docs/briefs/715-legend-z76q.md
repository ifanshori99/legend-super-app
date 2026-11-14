# Brief: engineer (Codex) — Printer stasiun dicek ulang saat cetak (legend-z76q)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Jangan jalankan `bd` selain `bd show` read-only.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree: `git worktree add -b fix/print-dispatch-recheck .worktrees/print-dispatch-recheck origin/milestone/m1`.

## Tujuan
bd show legend-z76q. Dispatcher cetak harus mengecek ulang printer stasiun saat mencetak: devices.tenant_id dan outlet cocok, type='printer', status='active', revoked_at null; bila tidak, tolak/park dengan status jelas dan log, jangan cetak ke perangkat dicabut atau milik outlet lain. Cek dulu siapa yang membaca stations.printer_device_id (bisa belum ada konsumen: laporkan dan buat penjaga di resolver/dispatcher yang ada). Tanpa migrasi; jangan ubah pairing/autentikasi perangkat. Test gagal-dulu: perangkat dicabut, outlet lain, tipe salah, nonaktif.

## Bukti, sebelum melapor
Test gagal-dulu lalu hijau lewat `heavy`, pra-gate AGENTS.md pada file yang diubah (prettier, eslint, typecheck api lewat `heavy` bila TypeScript berubah). Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Push `fix/print-dispatch-recheck` tanpa force. Jangan merge, jangan deploy.
