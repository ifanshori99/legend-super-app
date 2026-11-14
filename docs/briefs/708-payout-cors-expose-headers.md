# Brief: engineer (Codex) — CORS ekspor payout tidak membuka header nama file dan checksum (legend-3lel2)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Jangan jalankan `bd` selain `bd show` read-only.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree sendiri: `git worktree add -b fix/payout-cors-expose-headers .worktrees/payout-cors-expose-headers origin/milestone/m1`.

## Tujuan
`apps/api/src/app.ts` (sekitar baris 288) `exposedHeaders` CORS tidak memuat `Content-Disposition` dan `X-Content-Checksum-Sha256`, jadi browser lintas-origin tidak bisa membaca nama file dan checksum ekspor `POST /disbursement-batches/:id/export`. Tambahkan dua header itu saja. Jangan longgarkan origin, credentials, atau header lain. Test gagal-dulu: respons preflight/actual dari `WEB_URL` memuat kedua header di `Access-Control-Expose-Headers`. Jangan ubah logika payout.

## Bukti, sebelum melapor
Test terarah merah di base lalu hijau lewat `heavy`, pra-gate AGENTS.md (prettier, eslint, typecheck api lewat `heavy`). Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Push `fix/payout-cors-expose-headers` tanpa force. Jangan merge, jangan deploy.
