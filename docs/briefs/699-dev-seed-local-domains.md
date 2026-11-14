# Brief: engineer (Codex) — seed dev mendaftarkan domain localhost (legend-vq14)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Jangan jalankan `bd` selain `bd show` read-only.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree sendiri: `git worktree add -b fix/dev-seed-local-domains .worktrees/dev-seed-local-domains milestone/m1`.

## Tujuan
Setelah legend-wu06 (resolver tenant berbasis domain di depan `/api/auth/login-challenges`), login WhatsApp di lokal terhadap API asli gagal karena `localhost`/`127.0.0.1` tidak terdaftar sebagai domain tenant. Seed dev mendaftarkan domain itu untuk tenant contoh, idempoten, hanya di dev/test (tidak pernah di production: jaga dengan cek env yang sudah ada). Tanpa migrasi; bila butuh migrasi atau mengubah aturan resolver di production, berhenti dan laporkan.

## Bukti, sebelum melapor
Test gagal-dulu (login challenge lokal ditolak di base, diterima setelah seed), seed dijalankan dua kali tanpa duplikat, test terarah hijau lewat `heavy`, pra-gate AGENTS.md (prettier, eslint, typecheck api lewat `heavy`). Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Push `fix/dev-seed-local-domains` tanpa force. Jangan merge, jangan deploy.
