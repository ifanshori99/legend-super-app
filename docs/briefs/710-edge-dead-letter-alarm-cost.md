# Brief: engineer (Codex) — alarm dead-letter edge: biaya per sweep dan supervisor kosong (legend-mciif)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Jangan jalankan `bd` selain `bd show` read-only.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree sendiri: `git worktree add -b fix/edge-dead-letter-alarm-cost .worktrees/edge-dead-letter-alarm-cost origin/fix/edge-dead-letter-alarm`.

## Tujuan
Baca `bd show legend-mciif`. `core-outbox-dead-alert.ts` (sekitar 116-163) dan `core-outbox.ts` (sekitar 277-296): tiap sweep menjalankan lookup supervisor+policy+push untuk setiap head yang tertahan, query heads tanpa LIMIT. Bila outlet tidak punya supervisor/owner, `notifyOutletSupervisors` kembali tanpa baris dedupe, jadi dicoba lagi tiap sweep tanpa alarm sampai siapa pun. Perbaiki: cek dedupe sebelum lookup mahal, batasi jumlah head per sweep (LIMIT yang wajar, sisanya sweep berikut), dan bila tidak ada penerima, fallback ke owner tenant atau catat log error sekali (dengan dedupe) supaya tidak diam. Tanpa migrasi; bila butuh migrasi atau menyentuh akses, berhenti dan laporkan.

## Bukti, sebelum melapor
Test gagal-dulu (merah di base) untuk: dedupe mencegah lookup ulang, LIMIT per sweep, outlet tanpa supervisor menghasilkan fallback/log sekali. Test terarah hijau lewat `heavy`, pra-gate AGENTS.md (prettier, eslint, typecheck api lewat `heavy`). Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Push `fix/edge-dead-letter-alarm-cost` tanpa force. Jangan merge, jangan deploy.
