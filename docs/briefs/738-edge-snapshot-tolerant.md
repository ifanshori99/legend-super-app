# Brief: engineer (Codex) — skema snapshot edge toleran field baru (legend-pitm6)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Jangan jalankan `bd` selain `bd show legend-pitm6` read-only.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree: `git worktree add -b fix/edge-snapshot-tolerant .worktrees/edge-snapshot-tolerant origin/fix/edge-uom-issystem` (181547f9f, belum masuk milestone).

## Tujuan (keputusan CTO)
Edge yang menerima snapshot/pesan sync dari cloud dengan field yang tidak ia kenal harus membuang field itu (strip), bukan menolak seluruh snapshot. Berlaku untuk semua skema pesan cloud->edge di `packages/shared/src/edge/` yang dipakai edge untuk parse masuk. Validasi tipe field yang dikenal tetap ketat. Input dari klien/pengguna ke API tetap strict (aturan AGENTS.md); jangan longgarkan skema input API. Edge->cloud tetap strict di sisi cloud.

## Bukti, sebelum melapor
Test gagal-dulu: edge versi sekarang menerima snapshot dengan field tambahan tak dikenal (sebelumnya ditolak), field dikenal bertipe salah tetap ditolak. Daftar skema yang diubah di laporan. Pra-gate AGENTS.md (prettier, eslint, typecheck api dan web lewat `heavy`). Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Jangan ubah `docs/PROGRESS.md`. Push cabang tanpa force. Jangan merge, jangan deploy.
