# Brief: engineer (Codex) — celah kontrak alert panik (legend-5egl3, legend-td6pj, legend-2sr38)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Jangan jalankan `bd` selain `bd show <id>` read-only. Satu subagent per kartu bila file terpisah.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree: `git worktree add -b ws/panic-contract-gaps .worktrees/panic-contract-gaps origin/milestone/m1`. UI konsumen: `ui/panic-alert` 8d63ae311 (disetujui founder). Jangan ubah UI di cabang ini; catat kebutuhan wiring di laporan.

## Tujuan (ikuti isi kartu)
1. legend-5egl3: frame WebSocket `acknowledged` dikirim ke semua penerima saat satu staf menangani alert (siapa, kapan, alertId).
2. legend-td6pj: 409 `PANIC_ALREADY_ACKNOWLEDGED` membawa penanggap terstruktur (`acknowledgedBy: { displayName }`, `acknowledgedAt`); userId mentah keluar dari message.
3. legend-2sr38: frame panik membawa label lokasi; endpoint daftar alert terbuka untuk penerima setelah muat ulang, dibatasi tenant/fasilitas penerima.
Ini fitur keselamatan: alert tidak boleh hilang atau tertunda karena perubahan ini. Tanpa migrasi kecuali terpaksa (nomor 0605, lapor dulu).

## Bukti, sebelum melapor
Test gagal-dulu lalu hijau (`LEGEND_TEST_FILES=... heavy pnpm test`): frame acknowledged sampai ke penerima lain, 409 tanpa userId, daftar terbuka tidak bocor ke tenant/fasilitas lain. Review independen satu subagent. Pra-gate AGENTS.md (prettier, eslint, typecheck api dan web lewat `heavy`). Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Jangan ubah `docs/PROGRESS.md`. Push cabang tanpa force. Jangan merge, jangan deploy.
