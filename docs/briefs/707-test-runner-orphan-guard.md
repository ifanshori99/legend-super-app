# Brief: engineer (Codex) — test di luar jangkauan runner (legend-xpmbb)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Jangan jalankan `bd` selain `bd show` read-only.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree sendiri: `git worktree add -b fix/test-orphan-guard .worktrees/test-orphan-guard origin/milestone/m1`.

## Tujuan
Dua kali hari ini test baru ditaruh di `apps/web/src/**/test/*.test.mjs` dan tidak pernah dijalankan `pnpm test` (`scripts/test.mjs` hanya mengoleksi `tests/*.test.mjs`; API memakai vitest di `apps/api/src/test`). Tambahkan guard yang gagal (dengan pesan jelas: "pindahkan ke tests/ atau pola X") bila ada file test (`*.test.{mjs,ts,tsx}`) di luar pola yang dikoleksi runner mana pun. Jalankan guard di `pnpm check` atau sebagai test root (`tests/*.test.mjs`) supaya ikut CI. Inventaris dulu: bila sekarang sudah ada test yatim di milestone, daftarkan di laporan dan pindahkan yang aman (jangan hapus test).

## Bukti, sebelum melapor
Guard merah dengan file test yatim buatan, hijau di tree bersih; test yatim yang ditemukan dipindah dan lulus lewat `heavy`. Pra-gate AGENTS.md pada file yang diubah. Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Push `fix/test-orphan-guard` tanpa force. Jangan merge, jangan deploy.
