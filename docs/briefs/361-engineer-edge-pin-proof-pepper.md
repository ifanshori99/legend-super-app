# Brief: engineer — bukti PIN absen edge lalu pepper PIN per outlet (legend-u7g9w, legend-jmsdx)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta "Kerja berat" di `~/.agents/team/TEAM.md` (Grep judul bagian, Read offset/limit), lalu ikuti. Tingkat K (auth + migrasi): satu subagent architect review per kartu.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Dua kartu BERURUTAN di thread ini (keduanya menyentuh `device-pin.service.ts`):
1. `legend-u7g9w`: `git worktree add .worktrees/u7g9w-pin-proof -b ws/u7g9w-pin-proof origin/ws/j6cyb-edge-attendance` (d0376c66).
2. `legend-jmsdx`: sesudah 1 selesai, `git worktree add .worktrees/jmsdx-pepper -b ws/jmsdx-pepper origin/ws/ideif-edge-pepper`, lalu merge `ws/u7g9w-pin-proof` ke dalamnya supaya konflik `device-pin.service.ts` selesai di sini.
Push cabang kerja ke origin tiap commit. Jangan push main, jangan --force.

## Tujuan
Ikuti keputusan architect di `docs/DECISIONS.md` cabang `origin/ws/arch-357-decisions` (da63d494), entri 1 (bukti PIN 120 s, route `POST /api/hris/attendance/outlet-clock`, throttle device, CORS `X-Device-Token`/`X-Pin-Proof`) dan entri 2 (pepper v2+ per outlet, rehash hanya di cloud, `pin_generation_at`, runbook `docs/runbooks/edge-node-stolen.md`). Kriteria terima ada di kartu.

## Kartu
`legend-u7g9w` lalu `legend-jmsdx`. Tiap kartu: di awal `ghostex board associate <id>` dan `bd update <id> --status in_progress`; selesai `bd update <id> --status review` dan `bd comment <id> "<ringkasan>"`.

## Scope
- Boleh diubah: modul HRIS attendance, staff/device PIN, edge mode allowlist, `app.ts` CORS, kontrak terkait di `packages/shared`, runbook baru.
- Jangan disentuh: pembayaran, akuntansi, QR order, inventori.
- Migrasi: u7g9w pakai 0241 saja; jmsdx tanpa migrasi (sesuai keputusan). FK inline, migrator non-superuser.

## Bukti selesai
- Test gagal-dulu tiap kriteria (bukti kedaluwarsa, replay, device lain, staf lain, throttle 429, MFA tidak diminta, rehash tidak menimpa PIN baru edge).
- Typecheck dan test terarah lewat `heavy`. Architect review per kartu, temuan nyata dibetulkan.

## Batas kerja ulang (Retro 11)
- `typecheck`/`tsc` gagal 2 kali: baca `~/.claude/state/heavy-fail/<berkas terbaru>` sampai habis, betulkan SEMUA error, jalankan sekali lagi. Gagal ketiga: lapor dengan isi log.
- Jangan `pkill`/`killall`. Jam dari `date '+%H:%M'`. Edit pakai tool Edit.

## Sebelum melapor
Selesaikan KEDUA kartu, lalu lapor sekali. Commit, push, update `docs/PROGRESS.md`.

## Laporan
Per kartu: SHA, test gagal-dulu, temuan review, risiko. Plus urutan merge yang disarankan untuk merge train.
