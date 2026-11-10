# Brief: engineer — cek ganti kasir POS dengan PIN (legend-aruta)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta "Kerja berat" di `~/.agents/team/TEAM.md` (Grep judul bagian, Read offset/limit), lalu ikuti. Tingkat K (akses + uang): satu subagent architect review bila ada perbaikan.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. `git worktree add .worktrees/aruta-pos-pin -b ws/aruta-pos-pin milestone/m1`. Push cabang kerja ke origin tiap commit. Jangan push main, jangan --force.

## Tujuan
Bug dulu direproduksi: apakah ganti kasir di POS dengan PIN hanya terjadi di klien, sehingga void, diskon, refund, tender, override tercatat atas nama pemilik sesi, bukan kasir yang mengetik PIN? Tulis test yang membuktikan (merah bila bug nyata). Bila nyata: perbaiki di server. Pakai pola bukti PIN dari keputusan 1 `docs/DECISIONS.md` cabang `origin/ws/arch-357-decisions` (da63d494) bila cocok; jangan menyalin kode `ws/u7g9w-pin-proof` (sedang dikerjakan thread lain) — tulis helper sendiri bila perlu dan catat untuk merge train. Bila tidak nyata: laporkan bukti dan tutup kartu.

## Kartu
`legend-aruta`. `ghostex board associate legend-aruta`, `bd update legend-aruta --status in_progress`; selesai `--status review` + `bd comment`.

## Scope
- Boleh diubah: rute/service POS (shift, tender, void, diskon, override), staff PIN verify sisi POS, kontrak terkait.
- Jangan disentuh: HRIS attendance, edge mode allowlist, `device-pin.service.ts` (dipegang thread u7g9w), pembayaran gateway, migrasi 0229.
- Migrasi: 0243 saja bila perlu. `when` unik dan lebih tinggi dari semua `_journal.json` di `.worktrees/*`.

## Bukti selesai
- Test gagal-dulu yang mereproduksi (atau bukti tidak ada bug).
- Typecheck dan test terarah lewat `heavy`. Architect review bila ada fix.

## Batas kerja ulang (Retro 11)
- `typecheck`/`tsc` gagal 2 kali: baca `~/.claude/state/heavy-fail/<berkas terbaru>` sampai habis, betulkan SEMUA error, jalankan sekali lagi. Gagal ketiga: lapor dengan isi log.
- Jangan `pkill`/`killall`. Jam dari `date '+%H:%M'`. Edit pakai tool Edit.

## Laporan
Bug nyata atau tidak (dengan bukti), SHA, test gagal-dulu, temuan review, risiko.
