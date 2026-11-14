# Brief: engineer (Codex) — banner offline edge muncul di area platform (legend-bw2q)

## Peran
Baca `~/.agents/team/roles/engineer.md`, lalu ikuti. Jangan jalankan `bd` selain `bd show` read-only.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree sendiri: `git worktree add -b fix/platform-offline-banner .worktrees/platform-offline-banner milestone/m1`.

## Tujuan
`OfflineBannerSlot` menampilkan "Status edge node tidak tersedia... hubungi supervisor" pada skenario error di `/platform/*`. Panel platform dilayani cloud dan tidak punya edge node. Banner tidak boleh tampil di area platform; area outlet tetap seperti sekarang. Hanya `apps/web`, tanpa teks UI baru.

## Bukti, sebelum melapor
Test komponen/route gagal-dulu (banner muncul di /platform di base), hijau setelah perbaikan, area outlet tetap menampilkan banner. Pra-gate AGENTS.md (prettier, eslint, typecheck web lewat `heavy`). Push `fix/platform-offline-banner` tanpa force. Ikuti `~/.agents/team/brief-template.md` "Sebelum melapor", "Laporan". Jangan merge, jangan deploy.
